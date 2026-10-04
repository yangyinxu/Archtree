import { createHash, randomBytes } from 'node:crypto';
import { ObjectId, type ClientSession, type Filter } from 'mongodb';
import {
    SOCIAL_LIMITS, SocialError, exactSocialKeys, isSocialId, normalizeSocialHandle, parseSocialCommand,
    type SocialActor, type SocialApi, type SocialCard, type SocialCommand, type SocialListKind,
    type SocialMutationIdentity, type SocialOutcome, type SocialPage
} from '../../contracts/socialV1';
import { socialRollout } from '../../config/socialRollout';
import { getDatabaseClient, getDb } from '../../infrastructure/database';
import { touchActiveAccount, AccountReferenceUnavailableError } from '../../services/accountReferenceFenceService';
import { getJwtSecret } from '../../services/authSessionService';
import type {
    SocialBudgetDocument, SocialHandleDocument, SocialOutboxDocument, SocialProfileDocument,
    SocialReceiptDocument, SocialRelationshipDocument, SocialReportDocument
} from '../../repositories/social/socialDocuments';
import { readSocialToken, signSocialToken } from './socialTokens';
import { applyRoomSafety, roomSafetyAccountIds } from '../rooms/roomLifecycle';
import { notifyRoomChanges } from '../../realtime/roomEvents';
import { SOCIAL_TRANSACTION_ATTEMPTS, waitForSocialTransactionRetry } from './socialTransactionRetry';
import { createMusicShareService, type ResolveMusicShareContent } from './musicShareService';
import { deleteMusicShares, invalidateMusicShareAccounts, musicShareAccountIds } from './socialShareLifecycle';
import { createListeningService } from './listeningService';
import { clearListeningAccount } from './listeningLifecycle';
import { LISTENING_LIMITS, parseListeningReport } from '../../contracts/listeningV1';
import { isReservedSocialAlias, isReservedSocialHandle } from './socialNamePolicy';
import {
    invalidateSocialAccounts, nextRelationshipRevision, nextSocialRevision, retainRelationshipRevision
} from './socialGraphWrites';

export interface SocialServiceOptions {
    now?: () => number;
    enabled?: () => boolean;
    secret?: () => string;
    resolveMusicShareContent?: ResolveMusicShareContent;
    resolveListeningContent?: ResolveMusicShareContent;
    listeningRoomsEnabled?: () => boolean;
    /** Isolated transaction-race hooks; the application never supplies these. */
    beforeAccountFence?: (actor: SocialActor, session: ClientSession) => Promise<void>;
    afterAccountFence?: (actor: SocialActor, session: ClientSession) => Promise<void>;
    beforeCommit?: (session: ClientSession) => Promise<void>;
    afterCommit?: () => Promise<void>;
}

type MutationPlan = { outcome: 'applied' | 'noop'; affected: string[]; write: () => Promise<void> };
const emptyPlan = (): MutationPlan => ({ outcome: 'noop', affected: [], write: async () => undefined });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const pairId = (a: string, b: string) => [a, b].sort().join(':');
const objectId = (value: string) => /^[a-f0-9]{24}$/.test(value);
const card = (profile: SocialProfileDocument): SocialCard => ({
    socialId: profile._id, handle: profile.handle, alias: profile.alias, iconSeed: profile._id
});
const nextRevision = nextSocialRevision;

/**
 * Transactional social identity and relationship boundary. Account/session fences,
 * immutable scopes, status-only receipts and coalesced invalidations commit together.
 * There are deliberately no room memberships or external dispatches in this service.
 */
export const createSocialService = (options: SocialServiceOptions = {}): SocialApi => {
    const now = options.now ?? Date.now;
    const secret = options.secret ?? getJwtSecret;
    const enabled = options.enabled ?? (() => socialRollout().socialEnabled);
    const music = createMusicShareService({ now, secret, resolveContent: options.resolveMusicShareContent });
    const listening = createListeningService({ now, enabled, secret, resolveContent: options.resolveListeningContent, roomsEnabled: options.listeningRoomsEnabled });
    const db = () => { const value = getDb(); if (!value) throw new SocialError(503, 'social_unavailable'); return value; };
    const profiles = () => db().collection<SocialProfileDocument>('socialProfiles');
    const relationships = () => db().collection<SocialRelationshipDocument>('socialRelationships');
    const receipts = () => db().collection<SocialReceiptDocument>('socialMutations');
    const budgets = () => db().collection<SocialBudgetDocument>('socialBudgets');
    const handles = () => db().collection<SocialHandleDocument>('socialHandles');
    const reports = () => db().collection<SocialReportDocument>('socialReports');
    const outbox = () => db().collection<SocialOutboxDocument>('socialOutbox');

    /** Bounded known-aborted retries preserve the original intent; uncertain commits are never replayed. */
    const transaction = async <T>(actor: SocialActor, work: (session: ClientSession) => Promise<T>, hooks = false,
        additionalAccounts?: (session: ClientSession) => Promise<string[]>): Promise<T> => {
        if (!objectId(actor.userId) || !objectId(actor.sessionId)) throw new SocialError(401, 'social_session_required');
        for (let attempt = 0; attempt < SOCIAL_TRANSACTION_ATTEMPTS; attempt += 1) {
            const session = getDatabaseClient().startSession();
            let committed = false;
            try {
                session.startTransaction({ readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, maxCommitTimeMS: 5_000 });
                const auth = await db().collection('authSessions').updateOne({
                    _id: new ObjectId(actor.sessionId), userId: actor.userId,
                    revokedAt: { $exists: false }, expiresAt: { $gt: new Date(now()) }
                }, { $inc: { socialMutationRevision: 1 } }, { session });
                if (!auth.matchedCount) throw new SocialError(401, 'social_session_required');
                if (hooks) await options.beforeAccountFence?.(actor, session);
                const accountIds = [...new Set([actor.userId, ...await additionalAccounts?.(session) ?? []])].sort();
                for (const accountId of accountIds) await touchActiveAccount(accountId, session);
                if (hooks) await options.afterAccountFence?.(actor, session);
                const result = await work(session);
                if (hooks) await options.beforeCommit?.(session);
                await session.commitTransaction();
                committed = true;
                if (hooks) await options.afterCommit?.();
                return result;
            } catch (error) {
                await session.abortTransaction().catch(() => undefined);
                const mongo = error as { code?: number; hasErrorLabel?: (label: string) => boolean };
                if (committed || mongo.hasErrorLabel?.('UnknownTransactionCommitResult')) throw new SocialError(503, 'mutation_outcome_unknown');
                if (error instanceof SocialError) throw error;
                if (error instanceof AccountReferenceUnavailableError) throw new SocialError(401, 'account_unavailable');
                if (attempt + 1 < SOCIAL_TRANSACTION_ATTEMPTS && (mongo.hasErrorLabel?.('TransientTransactionError') || mongo.code === 11000)) {
                    await waitForSocialTransactionRetry(attempt);
                    continue;
                }
                throw new SocialError(503, 'social_unavailable');
            } finally { await session.endSession(); }
        }
        throw new SocialError(503, 'social_unavailable');
    };

    const scope = (actor: SocialActor, token: string, allowExpired = false) => {
        const value = readSocialToken(token, secret());
        if (!exactSocialKeys(value, ['audience', 'accountId', 'id', 'expiresAt'])
            || value.audience !== 'social-mutation-v1' || value.accountId !== actor.userId
            || typeof value.id !== 'string' || !/^[a-f0-9]{32}$/.test(value.id)
            || !Number.isSafeInteger(value.expiresAt) || Number(value.expiresAt) < 1) throw new SocialError(400, 'mutation_scope_invalid');
        if (!allowExpired && now() >= Number(value.expiresAt)) throw new SocialError(410, 'mutation_scope_expired');
        return { id: value.id, expiresAt: Number(value.expiresAt) };
    };

    /**
     * Authenticated reads also spend a durable per-account budget kept in MongoDB. The router's request
     * window is keyed by account too, but it lives in one process's memory, so it resets on restart and is not
     * shared between instances.
     */
    const readTransaction = <T>(actor: SocialActor, work: (session: ClientSession) => Promise<T>): Promise<T> => transaction(actor, async session => {
        const previous = await budgets().findOne({ _id: actor.userId }, { session });
        const minute = Math.floor(now() / 60_000);
        const count = previous?.readMinute === minute ? previous.reads ?? 0 : 0;
        if (count >= SOCIAL_LIMITS.readsPerMinute) throw new SocialError(429, 'social_limit');
        await budgets().updateOne({ _id: actor.userId }, { $set: { accountId: actor.userId, readMinute: minute, reads: count + 1 } }, { upsert: true, session });
        return work(session);
    });

    const invalidate = (accountIds: string[], session: ClientSession) => invalidateSocialAccounts(accountIds, session, now());
    const relationshipRevision = nextRelationshipRevision;

    /** Admission limits are read only after owning the corresponding user-row write fence. */
    const capacity = async (accountId: string, session: ClientSession, kind: 'pending' | 'friends' | 'blocks' | 'edges') => {
        const filter: Filter<SocialRelationshipDocument> = kind === 'pending' ? { accountIds: accountId, state: 'pending' }
            : kind === 'friends' ? { accountIds: accountId, state: 'accepted' }
                : kind === 'blocks' ? { accountIds: accountId, blockedBy: accountId } : { accountIds: accountId };
        if (await relationships().countDocuments(filter, { session, limit: SOCIAL_LIMITS[kind] }) >= SOCIAL_LIMITS[kind]) throw new SocialError(429, 'social_limit');
    };

    /**
     * Reporting is a safety action: a deactivated or suspended reporter may still report any other existing
     * profile whose social ID it holds, including a blocked pair. Nothing is written for, or signalled to,
     * the target. A repeat for the same target on the same UTC day is a noop and spends no daily allowance.
     */
    const planReport = async (actor: SocialActor, command: Extract<SocialCommand, { action: 'report' }>,
        current: SocialProfileDocument | null, session: ClientSession): Promise<MutationPlan> => {
        if (!current) throw new SocialError(404, 'profile_unavailable');
        const target = await profiles().findOne({ _id: command.targetSocialId }, { session });
        if (!target || target.accountId === actor.userId) throw new SocialError(404, 'profile_unavailable');
        const day = Math.floor(now() / SOCIAL_LIMITS.scopeMs);
        const dedupeKey = hash(JSON.stringify(['social-report-v1', actor.userId, target.accountId, day]));
        if (await reports().findOne({ dedupeKey }, { session, projection: { _id: 1 } })) return emptyPlan();
        const budget = await budgets().findOne({ _id: actor.userId }, { session });
        const count = budget?.reportDay === day ? budget.reports ?? 0 : 0;
        if (count >= SOCIAL_LIMITS.reportsPerDay) throw new SocialError(429, 'social_limit');
        const report: SocialReportDocument = {
            _id: `rp_${randomBytes(16).toString('hex')}`, dedupeKey,
            reporterAccountId: actor.userId, reporterSocialId: current._id,
            targetAccountId: target.accountId, targetSocialId: target._id, targetHandle: target.handle, targetAlias: target.alias,
            reason: command.reason, ...(command.note ? { note: command.note } : {}), state: 'open', createdAt: new Date(now())
        };
        return { outcome: 'applied', affected: [], write: async () => {
            await reports().insertOne(report, { session });
            await budgets().updateOne({ _id: actor.userId }, { $set: { accountId: actor.userId, reportDay: day, reports: count + 1 } }, { upsert: true, session });
        } };
    };

    /** Validation is separate from writes, so a rejected receipt cannot commit partial domain changes. */
    const plan = async (actor: SocialActor, command: SocialCommand, session: ClientSession): Promise<MutationPlan> => {
        if (command.action === 'setListeningSharing' || command.action === 'claimListening') return listening.plan(actor, command, session);
        if ('shareId' in command || command.action === 'shareMusic') return music.plan(actor, command, session);
        const current = await profiles().findOne({ accountId: actor.userId }, { session });
        if (command.action === 'profile') {
            // A suspension is lifted only by an administrator; the listener cannot edit or reactivate meanwhile.
            if (current?.suspension) throw new SocialError(403, 'social_suspended');
            if ((current?.revision ?? 0) !== command.expectedRevision) throw new SocialError(409, 'profile_revision_changed');
            if (current && current.handle !== command.handle) throw new SocialError(409, 'handle_immutable');
            // Only new choices are screened: a profile created before the name policy keeps its handle and
            // nickname (including through reactivation and discovery changes) until the nickname is edited.
            if (!current && isReservedSocialHandle(command.handle)) throw new SocialError(422, 'handle_reserved');
            if (current?.alias !== command.alias && isReservedSocialAlias(command.alias)) throw new SocialError(422, 'alias_reserved');
            const reservation = await handles().findOne({ _id: command.handle }, { session });
            if (reservation && reservation.accountId !== actor.userId && (!reservation.expiresAt || reservation.expiresAt.getTime() > now())) throw new SocialError(409, 'handle_unavailable');
            if (await profiles().findOne({ handle: command.handle, accountId: { $ne: actor.userId } }, { session })) throw new SocialError(409, 'handle_unavailable');
            if (current?.active && current.alias === command.alias && current.discoverable === command.discoverable) return emptyPlan();
            const profile: SocialProfileDocument = {
                _id: current?._id ?? `s_${randomBytes(16).toString('hex')}`, accountId: actor.userId,
                handle: command.handle, alias: command.alias, active: true, discoverable: command.discoverable,
                revision: nextRevision(current?.revision ?? 0), updatedAt: new Date(now())
            };
            return { outcome: 'applied', affected: [actor.userId], write: async () => {
                await handles().replaceOne({ _id: profile.handle }, { accountId: actor.userId }, { upsert: true, session });
                await profiles().replaceOne({ _id: profile._id }, profile, { upsert: true, session });
            } };
        }
        if (command.action === 'deactivate') {
            if (!current?.active) return emptyPlan();
            const edges = await relationships().find({ accountIds: actor.userId }, { session }).limit(SOCIAL_LIMITS.edges + 1).toArray();
            if (edges.length > SOCIAL_LIMITS.edges) throw new SocialError(503, 'social_unavailable');
            const peers = [...new Set(edges.flatMap(edge => edge.accountIds).filter(id => id !== actor.userId))].sort();
            const revision = nextRevision(current.revision);
            const accounts = [actor.userId, ...peers].sort();
            const edgeRevision = await relationshipRevision(accounts, Math.max(0, ...edges.map(edge => edge.revision)), session);
            return { outcome: 'applied', affected: [actor.userId, ...peers], write: async () => {
                await profiles().updateOne({ _id: current._id }, { $set: { active: false, discoverable: false, revision, updatedAt: new Date(now()) } }, { session });
                for (const edge of edges) {
                    const replacement = { ...edge, state: 'none' as const, revision: edgeRevision, updatedAt: new Date(now()) };
                    delete replacement.requestedBy;
                    if (!replacement.blockedBy.length) replacement.expiresAt = new Date(now() + SOCIAL_LIMITS.scopeMs + SOCIAL_LIMITS.receiptGraceMs);
                    else delete replacement.expiresAt;
                    await relationships().replaceOne({ _id: edge._id }, replacement, { session });
                }
                await retainRelationshipRevision(accounts, edgeRevision, session);
            } };
        }
        if (command.action === 'report') return planReport(actor, command, current, session);
        if (!current || (!current.active && command.action !== 'block' && command.action !== 'unblock')) throw new SocialError(404, 'profile_unavailable');
        const target = await profiles().findOne({ _id: command.targetSocialId }, { session });
        if (!target || target.accountId === actor.userId) {
            if (command.action === 'unblock') return emptyPlan();
            throw new SocialError(404, 'profile_unavailable');
        }
        const id = pairId(actor.userId, target.accountId);
        const existing = await relationships().findOne({ _id: id }, { session });
        // A peer's private block is not an observable precondition for this listener's unblock.
        if (command.action === 'unblock' && !existing?.blockedBy.includes(actor.userId)) return emptyPlan();
        if (command.action !== 'block' && command.action !== 'unblock'
            && (!target.active || existing?.blockedBy.length
                || (command.action === 'request' && !target.discoverable && (!existing || existing.state === 'none')))) throw new SocialError(404, 'profile_unavailable');
        if (command.action !== 'block' && (existing?.revision ?? 0) !== command.expectedRevision) throw new SocialError(409, 'relationship_changed');
        const accountIds = [actor.userId, target.accountId].sort();
        const edge: SocialRelationshipDocument = existing ? { ...existing, blockedBy: [...existing.blockedBy] } : {
            _id: id, accountIds, socialIds: accountIds.map(accountId => accountId === actor.userId ? current._id : target._id),
            state: 'none', blockedBy: [], revision: 0, updatedAt: new Date(now())
        };
        // Day budgets a new request spends; `incoming` is null when this sender already reached the recipient today.
        let requestBudget: { day: number; outgoing: number; incoming: number | null } | undefined;
        if (command.action === 'block') {
            if (edge.blockedBy.includes(actor.userId)) return emptyPlan();
            await capacity(actor.userId, session, 'blocks');
            edge.blockedBy.push(actor.userId);
            edge.state = 'none'; delete edge.requestedBy;
        } else if (command.action === 'unblock') {
            if (!edge.blockedBy.includes(actor.userId)) return emptyPlan();
            edge.blockedBy = edge.blockedBy.filter(id => id !== actor.userId);
            edge.state = 'none'; delete edge.requestedBy;
        } else {
            if (!target.active || edge.blockedBy.length) throw new SocialError(404, 'profile_unavailable');
            if (command.action === 'request') {
                if (edge.state === 'accepted' || (edge.state === 'pending' && edge.requestedBy === actor.userId)) return emptyPlan();
                if (edge.state === 'pending') throw new SocialError(409, 'request_pending');
                if (!target.discoverable) throw new SocialError(404, 'profile_unavailable');
                const day = Math.floor(now() / SOCIAL_LIMITS.scopeMs);
                const side = edge.accountIds.indexOf(actor.userId);
                const pairCounts = edge.requestDay === day && edge.requestCounts?.length === 2 ? [...edge.requestCounts] : [0, 0];
                // A sent request is spent even if it is later cancelled or declined, so a request-then-cancel
                // loop runs out of both the per-pair and the per-sender allowance instead of cycling forever.
                if (pairCounts[side] >= SOCIAL_LIMITS.pairRequestsPerDay) throw new SocialError(429, 'social_limit');
                const sender = await budgets().findOne({ _id: actor.userId }, { session });
                const outgoing = sender?.outgoingDay === day ? sender.outgoing ?? 0 : 0;
                if (outgoing >= SOCIAL_LIMITS.outgoingPerDay) throw new SocialError(429, 'social_limit');
                await capacity(actor.userId, session, 'pending');
                await capacity(target.accountId, session, 'pending');
                // The recipient's allowance counts distinct senders per day: a repeat request from a sender
                // already counted today is not charged again, so one sender cannot drain it for everyone else.
                let incoming: number | null = null;
                if (!pairCounts[side]) {
                    const recipient = await budgets().findOne({ _id: target.accountId }, { session });
                    incoming = recipient?.incomingDay === day ? recipient.incoming ?? 0 : 0;
                    if (incoming >= SOCIAL_LIMITS.incomingPerDay) throw new SocialError(429, 'social_limit');
                }
                pairCounts[side] += 1;
                edge.requestDay = day; edge.requestCounts = pairCounts;
                requestBudget = { day, outgoing: outgoing + 1, incoming: incoming === null ? null : incoming + 1 };
                edge.state = 'pending'; edge.requestedBy = actor.userId;
            } else if (command.action === 'accept') {
                if (edge.state !== 'pending' || edge.requestedBy === actor.userId) throw new SocialError(409, 'relationship_unavailable');
                await capacity(actor.userId, session, 'friends');
                await capacity(target.accountId, session, 'friends');
                edge.state = 'accepted'; delete edge.requestedBy;
            } else if (command.action === 'decline' || command.action === 'cancel') {
                if (edge.state === 'none') return emptyPlan();
                if (edge.state !== 'pending' || (edge.requestedBy === actor.userId) !== (command.action === 'cancel')) throw new SocialError(409, 'relationship_unavailable');
                edge.state = 'none'; delete edge.requestedBy;
            } else if (command.action === 'remove') {
                if (edge.state === 'none') return emptyPlan();
                if (edge.state !== 'accepted') throw new SocialError(409, 'relationship_unavailable');
                edge.state = 'none'; delete edge.requestedBy;
            }
        }
        if (!existing) {
            await capacity(actor.userId, session, 'edges');
            await capacity(target.accountId, session, 'edges');
        }
        edge.revision = await relationshipRevision(accountIds, edge.revision, session);
        edge.updatedAt = new Date(now());
        if (edge.state === 'none' && !edge.blockedBy.length) edge.expiresAt = new Date(now() + SOCIAL_LIMITS.scopeMs + SOCIAL_LIMITS.receiptGraceMs);
        else delete edge.expiresAt;
        return { outcome: 'applied', affected: [actor.userId, target.accountId], write: async () => {
            await relationships().replaceOne({ _id: edge._id }, edge, { upsert: true, session });
            await retainRelationshipRevision(accountIds, edge.revision, session);
            if (requestBudget) {
                const { day, outgoing, incoming } = requestBudget;
                await budgets().updateOne({ _id: actor.userId }, { $set: { accountId: actor.userId, outgoingDay: day, outgoing } }, { upsert: true, session });
                if (incoming !== null) await budgets().updateOne({ _id: target.accountId },
                    { $set: { accountId: target.accountId, incomingDay: day, incoming } }, { upsert: true, session });
            }
        } };
    };

    const api: SocialApi = {
        admissionEnabled: enabled,
        ownListening: actor => readTransaction(actor, session => listening.own(actor, session)),
        reportListening: (actor, input) => {
            const report = parseListeningReport(input);
            if (!report) throw new SocialError(400, 'invalid_request');
            return transaction(actor, session => listening.report(actor, report, session), true);
        },
        listeningStatuses: (actor, socialIds) => {
            if (!Array.isArray(socialIds) || !socialIds.length || socialIds.length > LISTENING_LIMITS.query
                || !socialIds.every(isSocialId) || new Set(socialIds).size !== socialIds.length) throw new SocialError(400, 'invalid_request');
            const captured = [...socialIds];
            return readTransaction(actor, session => listening.statuses(actor, captured, session));
        },
        listeningFriends: async (actor, limit, cursor) => {
            if (!Number.isSafeInteger(limit) || limit < 1 || limit > LISTENING_LIMITS.maximumPage
                || (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 1024))) throw new SocialError(400, 'invalid_request');
            return readTransaction(actor, session => listening.friends(actor, limit, cursor, session));
        },
        async issueScope(actor) {
            const id = randomBytes(16).toString('hex');
            return transaction(actor, async session => {
                const budget = await budgets().findOne({ _id: actor.userId }, { session });
                const day = Math.floor(now() / SOCIAL_LIMITS.scopeMs);
                const count = budget?.scopeDay === day ? budget.scopes ?? 0 : 0;
                if (count >= SOCIAL_LIMITS.scopesPerDay) throw new SocialError(429, 'social_limit');
                await budgets().updateOne({ _id: actor.userId }, { $set: { accountId: actor.userId, scopeDay: day, scopes: count + 1 } }, { upsert: true, session });
                const expiresAt = now() + SOCIAL_LIMITS.scopeMs;
                return { scopeToken: signSocialToken({ audience: 'social-mutation-v1', accountId: actor.userId, id, expiresAt }, secret()), expiresAt: new Date(expiresAt).toISOString() };
            });
        },
        async ownProfile(actor) {
            return readTransaction(actor, async session => {
                const profile = await profiles().findOne({ accountId: actor.userId }, { session });
                return profile ? { ...card(profile), active: profile.active, discoverable: profile.discoverable, revision: profile.revision,
                    ...(profile.suspension ? { suspended: true as const } : {}) } : null;
            });
        },
        /**
         * Clients poll this when no room socket can deliver `socialChanged`, so it must stay cheap:
         * a read-only session check replaces the transactional read fence, whose session, account
         * and budget writes would turn every idle poll into database writes. The router's
         * per-account request window still bounds it. Account deletion removes every session, so
         * a valid session also implies the account still exists.
         */
        async changeRevision(actor) {
            if (!objectId(actor.userId) || !objectId(actor.sessionId)) throw new SocialError(401, 'social_session_required');
            let current: [unknown, Pick<SocialOutboxDocument, 'revision'> | null];
            try {
                current = await Promise.all([
                    db().collection('authSessions').findOne({
                        _id: new ObjectId(actor.sessionId), userId: actor.userId,
                        revokedAt: { $exists: false }, expiresAt: { $gt: new Date(now()) }
                    }, { projection: { _id: 1 } }),
                    outbox().findOne({ _id: actor.userId }, { projection: { revision: 1 } })
                ]);
            } catch (error) {
                if (error instanceof SocialError) throw error;
                throw new SocialError(503, 'social_unavailable');
            }
            const [session, change] = current;
            if (!session) throw new SocialError(401, 'social_session_required');
            // A missing row means nothing has changed yet; a corrupt counter must not look like a valid cursor.
            const revision = change?.revision ?? 0;
            if (!Number.isSafeInteger(revision) || revision < 0) throw new SocialError(503, 'social_unavailable');
            return revision;
        },
        async lookup(actor, input) {
            const handle = normalizeSocialHandle(input);
            if (!handle) throw new SocialError(400, 'invalid_request');
            return readTransaction(actor, async session => {
                const target = await profiles().findOne({ handle, active: true, discoverable: true }, { session });
                if (!target) return null;
                const edge = await relationships().findOne({ _id: pairId(actor.userId, target.accountId) }, { session });
                return edge?.blockedBy.length ? null : card(target);
            });
        },
        async list(actor, kind, limit, cursor) {
            if (!['friends', 'incoming', 'outgoing', 'blocks'].includes(kind) || !Number.isSafeInteger(limit) || limit < 1 || limit > SOCIAL_LIMITS.maximumPage) throw new SocialError(400, 'invalid_request');
            let after = '';
            if (cursor !== undefined) {
                const value = cursor.length <= 512 ? readSocialToken(cursor, secret()) : null;
                if (!exactSocialKeys(value, ['audience', 'accountId', 'kind', 'after', 'expiresAt'])
                    || value.audience !== 'social-list-v1' || value.accountId !== actor.userId || value.kind !== kind
                    || !isSocialId(value.after) || !Number.isSafeInteger(value.expiresAt) || Number(value.expiresAt) <= now()) throw new SocialError(400, 'invalid_cursor');
                after = value.after;
            }
            return readTransaction(actor, async session => {
                const owner = await profiles().findOne({ accountId: actor.userId }, { session });
                if (!owner || (!owner.active && kind !== 'blocks')) return { items: [], nextCursor: null };
                const filter: Filter<SocialRelationshipDocument> = kind === 'blocks' ? { accountIds: actor.userId, blockedBy: actor.userId }
                    : kind === 'friends' ? { accountIds: actor.userId, state: 'accepted', blockedBy: { $size: 0 } }
                        : { accountIds: actor.userId, state: 'pending', blockedBy: { $size: 0 }, requestedBy: kind === 'outgoing' ? actor.userId : { $ne: actor.userId } };
                const edges = await relationships().find(filter, { session }).limit(SOCIAL_LIMITS.edges + 1).toArray();
                if (edges.length > SOCIAL_LIMITS.edges) throw new SocialError(503, 'social_unavailable');
                const candidates = edges.map(edge => ({ edge, socialId: edge.socialIds[edge.accountIds.findIndex(id => id !== actor.userId)] }))
                    .filter(value => value.socialId > after).sort((a, b) => a.socialId.localeCompare(b.socialId));
                const items: SocialPage['items'] = [];
                for (const candidate of candidates) {
                    const target = await profiles().findOne({ _id: candidate.socialId }, { session });
                    if (kind !== 'blocks' && !target?.active) continue;
                    items.push({ socialId: candidate.socialId, profile: kind !== 'blocks' && target?.active ? card(target) : null, revision: candidate.edge.revision });
                    if (items.length > limit) break;
                }
                const hasMore = items.length > limit;
                const page = items.slice(0, limit);
                return { items: page, nextCursor: hasMore ? signSocialToken({ audience: 'social-list-v1', accountId: actor.userId,
                    kind, after: page[page.length - 1].socialId, expiresAt: now() + 900_000 }, secret()) : null };
            });
        },
        async relationship(actor, targetSocialId) {
            if (!isSocialId(targetSocialId)) throw new SocialError(400, 'invalid_request');
            return readTransaction(actor, async session => {
                const owner = await profiles().findOne({ accountId: actor.userId }, { session });
                const target = await profiles().findOne({ _id: targetSocialId }, { session });
                if (!owner || !target || target.accountId === actor.userId) return null;
                const edge = await relationships().findOne({ _id: pairId(actor.userId, target.accountId) }, { session });
                if (edge?.blockedBy.includes(actor.userId)) return { socialId: targetSocialId, state: 'blocked' as const, revision: edge.revision };
                if (!owner.active || !target.active || edge?.blockedBy.length
                    || ((!edge || edge.state === 'none') && !target.discoverable)) return null;
                const state = edge?.state === 'accepted' ? 'friends' as const
                    : edge?.state === 'pending' ? edge.requestedBy === actor.userId ? 'outgoing' as const : 'incoming' as const : 'none' as const;
                return { socialId: targetSocialId, state, revision: edge?.revision ?? 0 };
            });
        },
        async musicShares(actor, direction, limit, cursor) {
            return readTransaction(actor, session => music.list(actor, direction, limit, cursor, session));
        },
        async mutate(actor, input) {
            const command = parseSocialCommand(input);
            if (!command) throw new SocialError(400, 'invalid_request');
            const originalScope = scope(actor, command.scopeToken);
            const id = hash(JSON.stringify([actor.userId, originalScope.id, command.commandId]));
            const digest = hash(JSON.stringify(Object.keys(command).filter(key => key !== 'scopeToken').sort()
                .map(key => [key, command[key as keyof SocialCommand]])));
            const result = await transaction(actor, async session => {
                const currentScope = scope(actor, command.scopeToken);
                const receipt = await receipts().findOne({ _id: id }, { session });
                if (receipt) {
                    if (receipt.digest !== digest) throw new SocialError(409, 'idempotency_conflict');
                    return { ...receipt.result, replayed: true };
                }
                const own = command.action === 'profile' ? await profiles().findOne({ accountId: actor.userId }, { session }) : null;
                const privacyOnlyProfile = command.action === 'profile' && own?.active === true && command.discoverable === false
                    && own.handle === command.handle && own.alias === command.alias;
                if (!enabled() && (['profile', 'request', 'accept', 'shareMusic', 'claimListening'].includes(command.action)
                    || (command.action === 'setListeningSharing' && command.enabled)) && !privacyOnlyProfile) throw new SocialError(503, 'social_disabled');
                await receipts().deleteMany({ accountId: actor.userId, expiresAt: { $lte: new Date(now()) } }, { session });
                const safety = privacyOnlyProfile || (command.action === 'setListeningSharing' && !command.enabled)
                    || ['block', 'unblock', 'deactivate', 'remove', 'decline', 'cancel', 'report', 'dismissMusicShare', 'withdrawMusicShare'].includes(command.action);
                // Admission cannot consume privacy-exit capacity; the final slot is reserved for deactivation.
                const receiptLimit = SOCIAL_LIMITS.receipts + (safety ? SOCIAL_LIMITS.safetyReceipts : 0) + (command.action === 'deactivate' ? 1 : 0);
                if (await receipts().countDocuments({ accountId: actor.userId }, { session, limit: receiptLimit }) >= receiptLimit) throw new SocialError(429, 'social_limit');
                const budget = await budgets().findOne({ _id: actor.userId }, { session });
                const minute = Math.floor(now() / 60_000);
                const count = budget?.commandMinute === minute ? budget.commands ?? 0 : 0;
                if (count >= SOCIAL_LIMITS.commandsPerMinute) throw new SocialError(429, 'social_limit');
                let operation: MutationPlan | undefined;
                let result: Omit<SocialOutcome, 'replayed'>;
                try {
                    operation = await plan(actor, command, session);
                    result = { commandId: command.commandId, outcome: operation.outcome };
                } catch (error) {
                    if (!(error instanceof SocialError) || error.statusCode >= 500 || error.statusCode === 401) throw error;
                    result = { commandId: command.commandId, outcome: 'rejected', code: error.code };
                }
                if (operation) {
                    await operation.write();
                    if (operation.outcome === 'applied') {
                        if (command.action === 'deactivate' || command.action === 'profile') {
                            await applyRoomSafety({ kind: command.action, accountId: actor.userId }, session, now());
                            if (command.action === 'deactivate') {
                                await deleteMusicShares({ accountIds: actor.userId }, session, now());
                                await clearListeningAccount(actor.userId, session, now());
                            }
                            else await invalidateMusicShareAccounts(await musicShareAccountIds({ accountIds: actor.userId }, session, now()), session, now());
                        } else if (command.action === 'block' || command.action === 'remove') {
                            const target = await profiles().findOne({ _id: command.targetSocialId }, { session });
                            if (target) await applyRoomSafety({ kind: command.action === 'block' ? 'block' : 'removeFriend',
                                accountId: actor.userId, targetAccountId: target.accountId }, session, now());
                            if (target) await deleteMusicShares({ accountIds: { $all: [actor.userId, target.accountId] } }, session, now());
                        }
                    }
                    await invalidate(operation.affected, session);
                }
                await budgets().updateOne({ _id: actor.userId }, { $set: { accountId: actor.userId, commandMinute: minute, commands: count + 1 } }, { upsert: true, session });
                await receipts().insertOne({ _id: id, accountId: actor.userId, scopeId: currentScope.id,
                    commandId: command.commandId, digest, result, scopeExpiresAt: new Date(currentScope.expiresAt),
                    expiresAt: new Date(currentScope.expiresAt + SOCIAL_LIMITS.receiptGraceMs) }, { session });
                return { ...result, replayed: false };
            }, true, async session => {
                const roomAccounts = ['deactivate', 'profile', 'block', 'remove'].includes(command.action)
                    ? await roomSafetyAccountIds(actor.userId, session) : [];
                const shareAccounts = ['deactivate', 'profile'].includes(command.action)
                    ? await musicShareAccountIds({ accountIds: actor.userId }, session, now())
                    : 'shareId' in command ? await musicShareAccountIds({ _id: command.shareId, accountIds: actor.userId }, session, now()) : [];
                if (command.action === 'deactivate') {
                    const edges = await relationships().find({ accountIds: actor.userId }, { session, projection: { accountIds: 1 } })
                        .limit(SOCIAL_LIMITS.edges + 1).toArray();
                    if (edges.length > SOCIAL_LIMITS.edges) throw new SocialError(503, 'social_unavailable');
                    return [...roomAccounts, ...shareAccounts, ...edges.flatMap(edge => edge.accountIds)];
                }
                if ('targetSocialId' in command) {
                    const target = await profiles().findOne({ _id: command.targetSocialId }, { session, projection: { accountId: 1 } });
                    return [...roomAccounts, ...(target ? [target.accountId] : [])];
                }
                return [...roomAccounts, ...shareAccounts];
            });
            // Listening and reports change no room or peer-visible state, so they wake no realtime delivery.
            if (result.outcome === 'applied' && !result.replayed && !['setListeningSharing', 'claimListening', 'report'].includes(command.action)) notifyRoomChanges();
            return result;
        },
        async outcome(actor, identity: SocialMutationIdentity) {
            if (!exactSocialKeys(identity, ['scopeToken', 'commandId']) || typeof identity.scopeToken !== 'string'
                || typeof identity.commandId !== 'string' || !/^[A-Za-z0-9_-]{16,80}$/.test(identity.commandId)) throw new SocialError(400, 'invalid_request');
            const mutationScope = scope(actor, identity.scopeToken, true);
            return readTransaction(actor, async session => {
                const receipt = await receipts().findOne({ _id: hash(JSON.stringify([actor.userId, mutationScope.id, identity.commandId])), accountId: actor.userId }, { session });
                return receipt && receipt.expiresAt.getTime() > now() ? { ...receipt.result, replayed: true } : null;
            });
        }
    };
    return api;
};
