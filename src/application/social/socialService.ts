import { createHash, randomBytes } from 'node:crypto';
import { ObjectId, type ClientSession, type Filter } from 'mongodb';
import {
    SOCIAL_LIMITS, SocialError, exactSocialKeys, isSocialId, normalizeSocialHandle, parseSocialCommand,
    type SocialActor, type SocialApi, type SocialCard, type SocialCommand, type SocialListKind,
    type SocialMutationIdentity, type SocialOutcome, type SocialPage
} from '../../contracts/socialV1';
import { getDatabaseClient, getDb } from '../../infrastructure/database';
import { touchActiveAccount, AccountReferenceUnavailableError } from '../../services/accountReferenceFenceService';
import { getJwtSecret } from '../../services/authSessionService';
import type {
    SocialBudgetDocument, SocialHandleDocument, SocialOutboxDocument, SocialProfileDocument,
    SocialReceiptDocument, SocialRelationshipDocument
} from '../../repositories/social/socialDocuments';
import { readSocialToken, signSocialToken } from './socialTokens';
import { applyRoomSafety, roomSafetyAccountIds } from '../rooms/roomLifecycle';
import { notifyRoomChanges } from '../../realtime/roomEvents';
import { SOCIAL_TRANSACTION_ATTEMPTS, waitForSocialTransactionRetry } from './socialTransactionRetry';

export interface SocialServiceOptions {
    now?: () => number;
    enabled?: () => boolean;
    secret?: () => string;
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
const nextRevision = (revision: number) => {
    if (!Number.isSafeInteger(revision) || revision < 0 || revision === Number.MAX_SAFE_INTEGER) throw new SocialError(503, 'social_unavailable');
    return revision + 1;
};

/**
 * Transactional social identity and relationship boundary. Account/session fences,
 * immutable scopes, status-only receipts and coalesced invalidations commit together.
 * There are deliberately no room memberships or external dispatches in this service.
 */
export const createSocialService = (options: SocialServiceOptions = {}): SocialApi => {
    const now = options.now ?? Date.now;
    const secret = options.secret ?? getJwtSecret;
    const enabled = options.enabled ?? (() => process.env.FINITUDE_SOCIAL_ENABLED === 'true');
    const db = () => { const value = getDb(); if (!value) throw new SocialError(503, 'social_unavailable'); return value; };
    const profiles = () => db().collection<SocialProfileDocument>('socialProfiles');
    const relationships = () => db().collection<SocialRelationshipDocument>('socialRelationships');
    const receipts = () => db().collection<SocialReceiptDocument>('socialMutations');
    const budgets = () => db().collection<SocialBudgetDocument>('socialBudgets');
    const handles = () => db().collection<SocialHandleDocument>('socialHandles');
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

    /** Authenticated reads have a durable actor budget in addition to the router's IP budget. */
    const readTransaction = <T>(actor: SocialActor, work: (session: ClientSession) => Promise<T>): Promise<T> => transaction(actor, async session => {
        const previous = await budgets().findOne({ _id: actor.userId }, { session });
        const minute = Math.floor(now() / 60_000);
        const count = previous?.readMinute === minute ? previous.reads ?? 0 : 0;
        if (count >= SOCIAL_LIMITS.readsPerMinute) throw new SocialError(429, 'social_limit');
        await budgets().updateOne({ _id: actor.userId }, { $set: { accountId: actor.userId, readMinute: minute, reads: count + 1 } }, { upsert: true, session });
        return work(session);
    });

    const invalidate = async (accountIds: string[], session: ClientSession) => {
        const unique = [...new Set(accountIds)].sort();
        if (unique.length) await outbox().bulkWrite(unique.map(accountId => ({ updateOne: {
            filter: { _id: accountId }, update: {
                $set: { accountId, updatedAt: new Date(now()) }, $inc: { revision: 1 }
            }, upsert: true
        } })), { session, ordered: true });
    };

    /** Account-held clocks outlive pair tombstones, preventing a new pair from reusing an old revision. */
    const relationshipRevision = async (accountIds: string[], minimum: number, session: ClientSession) => {
        const values = await budgets().find({ _id: { $in: accountIds } }, { session }).toArray();
        return nextRevision(Math.max(minimum, ...values.map(value => value.relationshipRevision ?? 0)));
    };
    const retainRelationshipRevision = async (accountIds: string[], revision: number, session: ClientSession) => {
        await budgets().bulkWrite(accountIds.map(accountId => ({ updateOne: {
            filter: { _id: accountId }, update: { $set: { accountId, relationshipRevision: revision } }, upsert: true
        } })), { session, ordered: true });
    };

    /** Admission limits are read only after owning the corresponding user-row write fence. */
    const capacity = async (accountId: string, session: ClientSession, kind: 'pending' | 'friends' | 'blocks' | 'edges') => {
        const filter: Filter<SocialRelationshipDocument> = kind === 'pending' ? { accountIds: accountId, state: 'pending' }
            : kind === 'friends' ? { accountIds: accountId, state: 'accepted' }
                : kind === 'blocks' ? { accountIds: accountId, blockedBy: accountId } : { accountIds: accountId };
        if (await relationships().countDocuments(filter, { session, limit: SOCIAL_LIMITS[kind] }) >= SOCIAL_LIMITS[kind]) throw new SocialError(429, 'social_limit');
    };

    /** Validation is separate from writes, so a rejected receipt cannot commit partial domain changes. */
    const plan = async (actor: SocialActor, command: SocialCommand, session: ClientSession): Promise<MutationPlan> => {
        const current = await profiles().findOne({ accountId: actor.userId }, { session });
        if (command.action === 'profile') {
            if ((current?.revision ?? 0) !== command.expectedRevision) throw new SocialError(409, 'profile_revision_changed');
            if (current && current.handle !== command.handle) throw new SocialError(409, 'handle_immutable');
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
        let consumeIncoming = false;
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
                await capacity(actor.userId, session, 'pending');
                await capacity(target.accountId, session, 'pending');
                const budget = await budgets().findOne({ _id: target.accountId }, { session });
                if (budget?.incomingDay === Math.floor(now() / SOCIAL_LIMITS.scopeMs) && (budget.incoming ?? 0) >= SOCIAL_LIMITS.incomingPerDay) throw new SocialError(429, 'social_limit');
                consumeIncoming = true;
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
            if (consumeIncoming) {
                const previous = await budgets().findOne({ _id: target.accountId }, { session });
                const day = Math.floor(now() / SOCIAL_LIMITS.scopeMs);
                await budgets().updateOne({ _id: target.accountId }, { $set: { accountId: target.accountId, incomingDay: day,
                    incoming: previous?.incomingDay === day ? (previous.incoming ?? 0) + 1 : 1 } }, { upsert: true, session });
            }
        } };
    };

    const api: SocialApi = {
        admissionEnabled: enabled,
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
                return profile ? { ...card(profile), active: profile.active, discoverable: profile.discoverable, revision: profile.revision } : null;
            });
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
                if (!enabled() && ['profile', 'request', 'accept'].includes(command.action) && !privacyOnlyProfile) throw new SocialError(503, 'social_disabled');
                await receipts().deleteMany({ accountId: actor.userId, expiresAt: { $lte: new Date(now()) } }, { session });
                const safety = privacyOnlyProfile || ['block', 'unblock', 'deactivate', 'remove', 'decline', 'cancel'].includes(command.action);
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
                        } else if (command.action === 'block' || command.action === 'remove') {
                            const target = await profiles().findOne({ _id: command.targetSocialId }, { session });
                            if (target) await applyRoomSafety({ kind: command.action === 'block' ? 'block' : 'removeFriend',
                                accountId: actor.userId, targetAccountId: target.accountId }, session, now());
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
                if (command.action === 'deactivate') {
                    const edges = await relationships().find({ accountIds: actor.userId }, { session, projection: { accountIds: 1 } })
                        .limit(SOCIAL_LIMITS.edges + 1).toArray();
                    if (edges.length > SOCIAL_LIMITS.edges) throw new SocialError(503, 'social_unavailable');
                    return [...roomAccounts, ...edges.flatMap(edge => edge.accountIds)];
                }
                if ('targetSocialId' in command) {
                    const target = await profiles().findOne({ _id: command.targetSocialId }, { session, projection: { accountId: 1 } });
                    return [...roomAccounts, ...(target ? [target.accountId] : [])];
                }
                return roomAccounts;
            });
            if (result.outcome === 'applied' && !result.replayed) notifyRoomChanges();
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
