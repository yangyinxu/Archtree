import type { ClientSession } from 'mongodb';
import { SOCIAL_LIMITS, SocialError, isSocialId, normalizeSocialHandle, type SocialReportReason } from '../../contracts/socialV1';
import { getDatabaseClient, getDb } from '../../infrastructure/database';
import { notifyRoomChanges } from '../../realtime/roomEvents';
import type {
    SocialProfileDocument, SocialRelationshipDocument, SocialReportDocument
} from '../../repositories/social/socialDocuments';
import { AccountReferenceUnavailableError, touchActiveAccount } from '../../services/accountReferenceFenceService';
import { applyRoomSafety, roomSafetyAccountIds } from '../rooms/roomLifecycle';
import { clearListeningAccount } from './listeningLifecycle';
import {
    invalidateSocialAccounts, nextRelationshipRevision, nextSocialRevision, retainRelationshipRevision
} from './socialGraphWrites';
import { deleteMusicShares, musicShareAccountIds } from './socialShareLifecycle';
import { SOCIAL_TRANSACTION_ATTEMPTS, waitForSocialTransactionRetry } from './socialTransactionRetry';

export const SOCIAL_MODERATION_LIMITS = Object.freeze({
    page: 50, maximumPage: 100, suspendedPage: 100, resolvedRetentionMs: 90 * 86_400_000
});

export type SocialReportState = 'open' | 'resolved';
export type SocialReportResolution = 'dismissed' | 'actioned';
export interface SocialModerationActor { userId: string }

/** Administrator view of one social identity; it never contains email, account IDs or private avatars. */
export interface SocialModerationProfile {
    socialId: string; handle: string; alias: string;
    status: 'active' | 'inactive' | 'suspended'; discoverable: boolean;
    suspendedAt: string | null; openReports: number;
}
export interface SocialModerationReport {
    reportId: string; reason: SocialReportReason; note: string | null; state: SocialReportState; createdAt: string;
    resolution: 'dismissed' | 'actioned' | 'suspended' | null; resolvedAt: string | null;
    /** What was reported, as it looked then; `current` is null once the profile is gone. */
    reported: { socialId: string; handle: string; alias: string; current: SocialModerationProfile | null };
    /** Null once the reporter's account has been deleted. */
    reporter: { socialId: string; handle: string | null } | null;
}
export interface SocialModerationReportPage { items: SocialModerationReport[]; nextCursor: string | null }
export interface SocialModerationOutcome<T> { outcome: 'applied' | 'noop'; value: T }

/** Router seam: isolated HTTP tests supply a fake; production uses the MongoDB implementation. */
export interface SocialModerationApi {
    listReports(input: { state: SocialReportState; limit: number; cursor?: string }): Promise<SocialModerationReportPage>;
    findProfile(handle: string): Promise<SocialModerationProfile | null>;
    listSuspended(): Promise<SocialModerationProfile[]>;
    resolveReport(actor: SocialModerationActor, reportId: string, resolution: SocialReportResolution): Promise<SocialModerationOutcome<SocialModerationReport>>;
    suspend(actor: SocialModerationActor, socialId: string): Promise<SocialModerationOutcome<SocialModerationProfile>>;
    unsuspend(actor: SocialModerationActor, socialId: string): Promise<SocialModerationOutcome<SocialModerationProfile>>;
}

export const isSocialReportId = (value: unknown): value is string => typeof value === 'string' && /^rp_[a-f0-9]{32}$/.test(value);
const cursorPattern = /^(\d{1,15})\.(rp_[a-f0-9]{32})$/;

export interface SocialModerationServiceOptions {
    now?: () => number;
    /** Isolated race hook after the account fences are held; the application never supplies it. */
    afterFences?: (session: ClientSession) => Promise<void>;
}

/**
 * Administrator moderation for social identities. Every change is idempotent by state, so an
 * uncertain commit can simply be retried: suspending a suspended profile, unsuspending an active
 * one, or resolving a resolved report is a noop.
 *
 * Suspension hides the profile everywhere an active profile is required (lookup, cards, lists,
 * shares, listening and rooms) by holding `active` and `discoverable` false. Pending requests are
 * cancelled, music shares and listening status are cleared, room participation ends (a hosted
 * room closes) and invitations are revoked, like deactivation. Accepted friendships and blocks are
 * kept, hidden from both sides, and reappear on unsuspension with the listener's own choices.
 */
export const createSocialModerationService = (options: SocialModerationServiceOptions = {}): SocialModerationApi => {
    const now = options.now ?? Date.now;
    const db = () => { const value = getDb(); if (!value) throw new SocialError(503, 'social_unavailable'); return value; };
    const profiles = () => db().collection<SocialProfileDocument>('socialProfiles');
    const relationships = () => db().collection<SocialRelationshipDocument>('socialRelationships');
    const reports = () => db().collection<SocialReportDocument>('socialReports');

    /** Bounded known-aborted retries; account fences serialize with listener commands and deletion. */
    const transaction = async <T>(accounts: (session: ClientSession) => Promise<string[]>,
        work: (session: ClientSession) => Promise<T>): Promise<T> => {
        for (let attempt = 0; attempt < SOCIAL_TRANSACTION_ATTEMPTS; attempt += 1) {
            const session = getDatabaseClient().startSession();
            let committed = false;
            try {
                session.startTransaction({ readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, maxCommitTimeMS: 5_000 });
                for (const accountId of [...new Set(await accounts(session))].sort()) await touchActiveAccount(accountId, session);
                await options.afterFences?.(session);
                const result = await work(session);
                await session.commitTransaction();
                committed = true;
                return result;
            } catch (error) {
                await session.abortTransaction().catch(() => undefined);
                const mongo = error as { code?: number; hasErrorLabel?: (label: string) => boolean };
                if (committed || mongo.hasErrorLabel?.('UnknownTransactionCommitResult')) throw new SocialError(503, 'mutation_outcome_unknown');
                if (error instanceof SocialError) throw error;
                // A peer deleted after the fence set was read: the retry reads the graph again.
                const retryable = error instanceof AccountReferenceUnavailableError
                    || mongo.hasErrorLabel?.('TransientTransactionError') || mongo.code === 11000;
                if (retryable && attempt + 1 < SOCIAL_TRANSACTION_ATTEMPTS) {
                    await waitForSocialTransactionRetry(attempt);
                    continue;
                }
                throw new SocialError(503, 'social_unavailable');
            } finally { await session.endSession(); }
        }
        throw new SocialError(503, 'social_unavailable');
    };

    const openReportCounts = async (accountIds: string[], session?: ClientSession) => {
        const counts = new Map<string, number>();
        if (!accountIds.length) return counts;
        const rows = await reports().aggregate<{ _id: string; count: number }>([
            { $match: { targetAccountId: { $in: [...new Set(accountIds)] }, state: 'open' } },
            { $group: { _id: '$targetAccountId', count: { $sum: 1 } } }
        ], { session }).toArray();
        for (const row of rows) counts.set(row._id, row.count);
        return counts;
    };
    const profileView = (profile: SocialProfileDocument, openReports: number): SocialModerationProfile => ({
        socialId: profile._id, handle: profile.handle, alias: profile.alias,
        status: profile.suspension ? 'suspended' : profile.active ? 'active' : 'inactive',
        discoverable: profile.suspension ? profile.suspension.restoreDiscoverable : profile.discoverable,
        suspendedAt: profile.suspension?.suspendedAt.toISOString() ?? null, openReports
    });
    const profileViews = async (rows: SocialProfileDocument[], session?: ClientSession) => {
        const counts = await openReportCounts(rows.map(row => row.accountId), session);
        return rows.map(row => profileView(row, counts.get(row.accountId) ?? 0));
    };
    const reportViews = async (rows: SocialReportDocument[], session?: ClientSession): Promise<SocialModerationReport[]> => {
        const socialIds = [...new Set(rows.flatMap(row => [row.targetSocialId, ...(row.reporterSocialId ? [row.reporterSocialId] : [])]))];
        const found = socialIds.length ? await profiles().find({ _id: { $in: socialIds } }, { session }).toArray() : [];
        const views = new Map((await profileViews(found, session)).map(view => [view.socialId, view]));
        return rows.map(row => ({
            reportId: row._id, reason: row.reason, note: row.note ?? null, state: row.state, createdAt: row.createdAt.toISOString(),
            resolution: row.resolution ?? null, resolvedAt: row.resolvedAt?.toISOString() ?? null,
            reported: { socialId: row.targetSocialId, handle: row.targetHandle, alias: row.targetAlias, current: views.get(row.targetSocialId) ?? null },
            reporter: row.reporterSocialId ? { socialId: row.reporterSocialId, handle: views.get(row.reporterSocialId)?.handle ?? null } : null
        }));
    };
    const resolvedFields = (actor: SocialModerationActor, resolution: 'dismissed' | 'actioned' | 'suspended', at: number) => ({
        state: 'resolved' as const, resolution, resolvedAt: new Date(at), resolvedBy: actor.userId,
        expiresAt: new Date(at + SOCIAL_MODERATION_LIMITS.resolvedRetentionMs)
    });
    const requireAdminActor = (actor: SocialModerationActor) => {
        if (!/^[a-f0-9]{24}$/.test(actor.userId)) throw new SocialError(401, 'session_required');
    };

    return {
        async listReports({ state, limit, cursor }) {
            if (!['open', 'resolved'].includes(state) || !Number.isSafeInteger(limit) || limit < 1
                || limit > SOCIAL_MODERATION_LIMITS.maximumPage) throw new SocialError(400, 'invalid_request');
            // Open reports are a triage queue (oldest first); resolved reports are an audit trail (newest first).
            const direction = state === 'open' ? 1 : -1;
            const filter: Record<string, unknown> = { state };
            if (cursor !== undefined) {
                const match = cursorPattern.exec(cursor);
                if (!match) throw new SocialError(400, 'invalid_cursor');
                const createdAt = new Date(Number(match[1]));
                filter.$or = [{ createdAt: direction === 1 ? { $gt: createdAt } : { $lt: createdAt } },
                    { createdAt, _id: direction === 1 ? { $gt: match[2] } : { $lt: match[2] } }];
            }
            const rows = await reports().find(filter).sort({ createdAt: direction, _id: direction }).limit(limit + 1).toArray();
            const page = rows.slice(0, limit);
            const last = page[page.length - 1];
            return { items: await reportViews(page),
                nextCursor: rows.length > limit && last ? `${last.createdAt.getTime()}.${last._id}` : null };
        },
        async findProfile(input) {
            const handle = normalizeSocialHandle(input);
            if (!handle) throw new SocialError(400, 'invalid_request');
            const profile = await profiles().findOne({ handle });
            return profile ? (await profileViews([profile]))[0] : null;
        },
        async listSuspended() {
            const rows = await profiles().find({ 'suspension.suspendedAt': { $exists: true } })
                .sort({ 'suspension.suspendedAt': -1, _id: 1 }).limit(SOCIAL_MODERATION_LIMITS.suspendedPage).toArray();
            return profileViews(rows);
        },
        async resolveReport(actor, reportId, resolution) {
            requireAdminActor(actor);
            if (!isSocialReportId(reportId) || !['dismissed', 'actioned'].includes(resolution)) throw new SocialError(400, 'invalid_request');
            // A single-document state transition needs no transaction or account fence.
            const updated = await reports().findOneAndUpdate({ _id: reportId, state: 'open' },
                { $set: resolvedFields(actor, resolution, now()) }, { returnDocument: 'after' });
            const row = updated.value ?? await reports().findOne({ _id: reportId });
            if (!row) throw new SocialError(404, 'report_unavailable');
            return { outcome: updated.value ? 'applied' : 'noop', value: (await reportViews([row]))[0] };
        },
        async suspend(actor, socialId) {
            requireAdminActor(actor);
            if (!isSocialId(socialId)) throw new SocialError(400, 'invalid_request');
            const result = await transaction(async session => {
                const profile = await profiles().findOne({ _id: socialId }, { session, projection: { accountId: 1, suspension: 1 } });
                if (!profile || profile.suspension) return [];
                const edges = await relationships().find({ accountIds: profile.accountId }, { session, projection: { accountIds: 1 } })
                    .limit(SOCIAL_LIMITS.edges + 1).toArray();
                if (edges.length > SOCIAL_LIMITS.edges) throw new SocialError(503, 'social_unavailable');
                return [profile.accountId, ...edges.flatMap(edge => edge.accountIds),
                    ...await roomSafetyAccountIds(profile.accountId, session),
                    ...await musicShareAccountIds({ accountIds: profile.accountId }, session, now())];
            }, async session => {
                const profile = await profiles().findOne({ _id: socialId }, { session });
                if (!profile) throw new SocialError(404, 'profile_unavailable');
                if (profile.suspension) return { outcome: 'noop' as const, profile };
                const at = now();
                const accountId = profile.accountId;
                const edges = await relationships().find({ accountIds: accountId }, { session }).limit(SOCIAL_LIMITS.edges + 1).toArray();
                if (edges.length > SOCIAL_LIMITS.edges) throw new SocialError(503, 'social_unavailable');
                // Requests are unsolicited contact the recipient could no longer answer, so they end now.
                const pending = edges.filter(edge => edge.state === 'pending');
                if (pending.length) {
                    const involved = [...new Set(pending.flatMap(edge => edge.accountIds))].sort();
                    const revision = await nextRelationshipRevision(involved, Math.max(...pending.map(edge => edge.revision)), session);
                    for (const edge of pending) {
                        const replacement: SocialRelationshipDocument = { ...edge, state: 'none', revision, updatedAt: new Date(at) };
                        delete replacement.requestedBy;
                        if (!replacement.blockedBy.length) replacement.expiresAt = new Date(at + SOCIAL_LIMITS.scopeMs + SOCIAL_LIMITS.receiptGraceMs);
                        await relationships().replaceOne({ _id: edge._id }, replacement, { session });
                    }
                    await retainRelationshipRevision(involved, revision, session);
                }
                const suspended: SocialProfileDocument = { ...profile, active: false, discoverable: false,
                    revision: nextSocialRevision(profile.revision), updatedAt: new Date(at),
                    suspension: { suspendedAt: new Date(at), suspendedBy: actor.userId,
                        restoreActive: profile.active, restoreDiscoverable: profile.discoverable } };
                await profiles().replaceOne({ _id: profile._id, revision: profile.revision }, suspended, { session });
                await applyRoomSafety({ kind: 'deactivate', accountId }, session, at);
                await deleteMusicShares({ accountIds: accountId }, session, at);
                await clearListeningAccount(accountId, session, at);
                await reports().updateMany({ targetAccountId: accountId, state: 'open' },
                    { $set: resolvedFields(actor, 'suspended', at) }, { session });
                await invalidateSocialAccounts([accountId, ...edges.flatMap(edge => edge.accountIds)], session, at);
                return { outcome: 'applied' as const, profile: suspended };
            });
            if (result.outcome === 'applied') notifyRoomChanges();
            return { outcome: result.outcome, value: (await profileViews([result.profile]))[0] };
        },
        async unsuspend(actor, socialId) {
            requireAdminActor(actor);
            if (!isSocialId(socialId)) throw new SocialError(400, 'invalid_request');
            const result = await transaction(async session => {
                const profile = await profiles().findOne({ _id: socialId }, { session, projection: { accountId: 1, suspension: 1 } });
                if (!profile?.suspension) return [];
                const edges = await relationships().find({ accountIds: profile.accountId }, { session, projection: { accountIds: 1 } })
                    .limit(SOCIAL_LIMITS.edges + 1).toArray();
                if (edges.length > SOCIAL_LIMITS.edges) throw new SocialError(503, 'social_unavailable');
                return [profile.accountId, ...edges.flatMap(edge => edge.accountIds)];
            }, async session => {
                const profile = await profiles().findOne({ _id: socialId }, { session });
                if (!profile) throw new SocialError(404, 'profile_unavailable');
                if (!profile.suspension) return { outcome: 'noop' as const, profile };
                const at = now();
                const edges = await relationships().find({ accountIds: profile.accountId }, { session, projection: { accountIds: 1 } })
                    .limit(SOCIAL_LIMITS.edges + 1).toArray();
                if (edges.length > SOCIAL_LIMITS.edges) throw new SocialError(503, 'social_unavailable');
                const { suspension, ...rest } = profile;
                const restored: SocialProfileDocument = { ...rest, active: suspension.restoreActive,
                    discoverable: suspension.restoreDiscoverable, revision: nextSocialRevision(profile.revision), updatedAt: new Date(at) };
                await profiles().replaceOne({ _id: profile._id, revision: profile.revision }, restored, { session });
                // Retained friends see the profile again, so their lists refresh as well.
                await invalidateSocialAccounts([profile.accountId, ...edges.flatMap(edge => edge.accountIds)], session, at);
                return { outcome: 'applied' as const, profile: restored };
            });
            if (result.outcome === 'applied') notifyRoomChanges();
            return { outcome: result.outcome, value: (await profileViews([result.profile]))[0] };
        }
    };
};
