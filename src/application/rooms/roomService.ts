import { createHash, randomBytes } from 'node:crypto';
import { ObjectId, type ClientSession } from 'mongodb';
import { ROOM_LIMITS, ROOM_MEDIA_DISCOVERY_LIMITS, normalizeRoomMediaQuery, isRoomClientId, isRoomIdentifier, parseRoomCommand, parseRoomHeartbeat, parseRoomReady,
    type RoomActor, type RoomApi, type RoomCommand, type RoomHeartbeat, type RoomInvitation, type RoomMediaDescriptor,
    type RoomCommunity, type RoomReadyReport, type RoomSnapshot } from '../../contracts/roomV1';
import { SOCIAL_LIMITS, SocialError, exactSocialKeys, type SocialOutcome } from '../../contracts/socialV1';
import { getDatabaseClient, getDb } from '../../infrastructure/database';
import { touchActiveAccount, AccountReferenceUnavailableError } from '../../services/accountReferenceFenceService';
import { getJwtSecret } from '../../services/authSessionService';
import { readyAudioStorageFilter } from '../../utils/audioStorageKey';
import { resolveRoomAudioRepresentation, touchRoomAudioRepresentation } from '../../services/mediaRepresentationService';
import { assertRoomAuthority } from '../../realtime/roomAuthority';
import { notifyRoomChanges } from '../../realtime/roomEvents';
import type { SocialBudgetDocument, SocialProfileDocument, SocialReceiptDocument, SocialRelationshipDocument } from '../../repositories/social/socialDocuments';
import type { RoomDocument, RoomInvitationDocument, RoomMemberDocument, RoomParticipationDocument, RoomQueueEntryDocument } from '../../repositories/social/roomDocuments';
import { readSocialToken, signSocialToken } from '../social/socialTokens';
import { SOCIAL_TRANSACTION_ATTEMPTS, waitForSocialTransactionRetry } from '../social/socialTransactionRetry';
import { suppressRoomListening } from '../social/listeningLifecycle';
import { appendRoomEvent, closeRoom, deleteRoomInvitations, incrementRoomVersion, invalidateInvitationAccounts, pauseRoom, persistRoom, removeRoomMember, roomPositionAt } from './roomLifecycle';

export interface RoomServiceOptions {
    now?: () => number;
    enabled?: () => boolean;
    secret?: () => string;
    assertAuthority?: (session: ClientSession) => Promise<number>;
    resolveMedia?: (id: string, session?: ClientSession) => Promise<RoomMediaDescriptor | null>;
    touchMedia?: (id: string, revision: string, session: ClientSession) => Promise<RoomMediaDescriptor | null>;
    beforeAccountFence?: (actor: RoomActor, session: ClientSession) => Promise<void>;
    beforeCommit?: (session: ClientSession) => Promise<void>;
    afterCommit?: () => Promise<void>;
    beforeSweepRoom?: (roomId: string) => Promise<void>;
}

const identifier = (prefix: string) => `${prefix}_${randomBytes(16).toString('hex')}`;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const pairId = (a: string, b: string) => [a, b].sort().join(':');
const fail = (code: string, status = 409): never => { throw new SocialError(status, code); };
type Planned = { outcome: 'applied' | 'noop'; write: () => Promise<void> };
const noop = (): Planned => ({ outcome: 'noop', write: async () => undefined });

/** Durable room authority: every user intent, timer and readiness transition commits before delivery. */
export const createRoomService = (options: RoomServiceOptions = {}): RoomApi => {
    const now = options.now ?? Date.now;
    const enabled = options.enabled ?? (() => process.env.FINITUDE_ROOMS_ENABLED === 'true' && process.env.FINITUDE_SOCIAL_ENABLED === 'true');
    const secret = options.secret ?? getJwtSecret;
    const authority = options.assertAuthority ?? assertRoomAuthority;
    const resolveMedia = options.resolveMedia ?? resolveRoomAudioRepresentation;
    const touchMedia = options.touchMedia ?? touchRoomAudioRepresentation;
    const db = () => { const value = getDb(); if (!value) return fail('room_unavailable', 503); return value; };
    const rooms = () => db().collection<RoomDocument>('socialRooms');
    const slots = () => db().collection<RoomParticipationDocument>('socialRoomParticipation');
    const invitations = () => db().collection<RoomInvitationDocument>('socialInvitations');
    const profiles = () => db().collection<SocialProfileDocument>('socialProfiles');
    const receipts = () => db().collection<SocialReceiptDocument>('socialMutations');
    const budgets = () => db().collection<SocialBudgetDocument>('socialBudgets');
    const connected = (member: RoomMemberDocument) => member.connectionPresent && now() - member.lastSeenAt.getTime() < ROOM_LIMITS.hostGraceMs;
    const controls = (member: RoomMemberDocument, actor: RoomActor) => member.controllerSessionId === actor.sessionId && member.controllerClientId === actor.clientId;
    const host = (room: RoomDocument) => room.members.find(member => member.membershipId === room.hostMembershipId);
    const hostPresent = (room: RoomDocument) => Boolean(host(room) && connected(host(room)!));
    const safeRoom = (room: RoomDocument | null): room is RoomDocument => Boolean(room && room.state === 'open' && room.expiresAt.getTime() > now());
    /** Discovery projects only the ready resolver's public descriptor, never its database evidence. */
    const mediaDescriptor = (value: RoomMediaDescriptor): RoomMediaDescriptor => ({ mediaTrackId: value.mediaTrackId,
        title: [...value.title].slice(0, 160).join(''), mediaRevision: value.mediaRevision, durationMs: value.durationMs,
        streamUrl: value.streamUrl, mediaType: value.mediaType });

    /** Session and sorted account writes serialize admission with revocation, block and account deletion. */
    const transaction = async <T>(actor: RoomActor | null, work: (session: ClientSession) => Promise<T>,
        accounts?: (session: ClientSession) => Promise<string[]>, hooks = false): Promise<T> => {
        if (actor && (!/^[a-f0-9]{24}$/.test(actor.userId) || !/^[a-f0-9]{24}$/.test(actor.sessionId) || !isRoomClientId(actor.clientId))) return fail('social_session_required', 401);
        for (let attempt = 0; attempt < SOCIAL_TRANSACTION_ATTEMPTS; attempt += 1) {
            const session = getDatabaseClient().startSession();
            let committed = false;
            try {
                session.startTransaction({ readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, maxCommitTimeMS: 5_000 });
                if (actor) {
                    const auth = await db().collection('authSessions').updateOne({ _id: new ObjectId(actor.sessionId), userId: actor.userId,
                        revokedAt: { $exists: false }, expiresAt: { $gt: new Date(now()) } }, { $inc: { socialMutationRevision: 1 } }, { session });
                    if (!auth.matchedCount) return fail('social_session_required', 401);
                    if (hooks) await options.beforeAccountFence?.(actor, session);
                }
                const ids = [...new Set([...(actor ? [actor.userId] : []), ...await accounts?.(session) ?? []])].sort();
                for (const id of ids) await touchActiveAccount(id, session);
                const result = await work(session);
                if (hooks) await options.beforeCommit?.(session);
                await session.commitTransaction(); committed = true;
                if (hooks) await options.afterCommit?.();
                return result;
            } catch (error) {
                await session.abortTransaction().catch(() => undefined);
                const mongo = error as { code?: number; hasErrorLabel?: (label: string) => boolean };
                if (committed || mongo.hasErrorLabel?.('UnknownTransactionCommitResult')) return fail('mutation_outcome_unknown', 503);
                if (error instanceof SocialError) throw error;
                if (error instanceof AccountReferenceUnavailableError) return fail('account_unavailable', 401);
                if (attempt + 1 < SOCIAL_TRANSACTION_ATTEMPTS && (mongo.code === 11000 || mongo.hasErrorLabel?.('TransientTransactionError'))) {
                    await waitForSocialTransactionRetry(attempt); continue;
                }
                return fail('room_unavailable', 503);
            } finally { await session.endSession(); }
        }
        return fail('room_unavailable', 503);
    };

    const scope = (actor: RoomActor, token: string) => {
        const parsed = readSocialToken(token, secret());
        if (!exactSocialKeys(parsed, ['audience', 'accountId', 'id', 'expiresAt']) || parsed.audience !== 'social-mutation-v1'
            || parsed.accountId !== actor.userId || typeof parsed.id !== 'string' || !/^[a-f0-9]{32}$/.test(parsed.id)
            || !Number.isSafeInteger(parsed.expiresAt) || Number(parsed.expiresAt) < 1) return fail('mutation_scope_invalid', 400);
        if (Number(parsed.expiresAt) <= now()) return fail('mutation_scope_expired', 410);
        return { id: parsed.id, expiresAt: Number(parsed.expiresAt) };
    };
    const profile = async (accountId: string, session: ClientSession) => {
        const value = await profiles().findOne({ accountId, active: true }, { session });
        if (!value) return fail('profile_unavailable', 404);
        return value;
    };
    const friends = async (a: string, b: string, session: ClientSession) => {
        const edge = await db().collection<SocialRelationshipDocument>('socialRelationships').findOne({ _id: pairId(a, b) }, { session });
        return edge?.state === 'accepted' && edge.blockedBy.length === 0;
    };
    /** List, link detail and host metadata resolve the same current lifecycle without retaining historical cards. */
    const availableInvitation = async (value: RoomInvitationDocument | null, session: ClientSession, knownRoom?: RoomDocument) => {
        if (!value || value.state !== 'pending' || value.expiresAt.getTime() <= now()) return null;
        const room = knownRoom ?? await rooms().findOne({ _id: value.roomId }, { session });
        if (!safeRoom(room) || room._id !== value.roomId || host(room)?.accountId !== value.senderAccountId) return null;
        const sender = await profiles().findOne({ accountId: value.senderAccountId, active: true }, { session });
        const recipient = await profiles().findOne({ accountId: value.recipientAccountId, active: true }, { session });
        if (!sender || !recipient || !await friends(value.recipientAccountId, value.senderAccountId, session)) return null;
        const invitation: RoomInvitation = { invitationId: value.invitationId, generation: value.generation,
            expiresAtMs: value.expiresAt.getTime(),
            inviter: { socialId: sender._id, handle: sender.handle, alias: sender.alias, iconSeed: sender._id } };
        return { invitation, recipientSocialId: recipient._id };
    };
    const noBlocks = async (accountId: string, room: RoomDocument, session: ClientSession) => {
        for (const member of room.members) {
            const edge = await db().collection<SocialRelationshipDocument>('socialRelationships').findOne({ _id: pairId(accountId, member.accountId) }, { session });
            if (edge?.blockedBy.length) return fail('room_unavailable', 404);
        }
    };
    const member = (room: RoomDocument, actor: RoomActor, memberId?: string) => {
        const value = room.members.find(candidate => candidate.accountId === actor.userId && (!memberId || candidate.membershipId === memberId));
        if (!value) return fail('room_unavailable', 404);
        return value;
    };
    const newMember = (actor: RoomActor, socialId: string): RoomMemberDocument => ({ membershipId: identifier('m'), accountId: actor.userId,
        socialId, controllerSessionId: actor.sessionId, controllerClientId: actor.clientId, controllerGeneration: 1,
        joinedAt: new Date(now()), lastSeenAt: new Date(now()), locallyPaused: false, connectionPresent: false });
    const cleanSlot = async (accountId: string, session: ClientSession) => {
        const slot = await slots().findOne({ _id: accountId }, { session });
        if (!slot) return;
        const room = await rooms().findOne({ _id: slot.roomId }, { session });
        if (safeRoom(room) && room.members.some(value => value.accountId === accountId && value.membershipId === slot.membershipId)) return fail('already_in_room');
        await slots().deleteOne({ _id: accountId, roomId: slot.roomId, membershipId: slot.membershipId }, { session });
    };
    const queueEntry = async (id: string, session: ClientSession, expectedRevision?: string): Promise<RoomQueueEntryDocument> => {
        const value = expectedRevision ? await touchMedia(id, expectedRevision, session) : await resolveMedia(id, session);
        if (!value || !Number.isSafeInteger(value.durationMs) || value.durationMs < 1 || value.durationMs > 86_400_000) return fail('room_media_unavailable', 404);
        if (!expectedRevision && !await touchMedia(id, value.mediaRevision, session)) return fail('room_media_unavailable', 404);
        return { ...value, title: [...value.title].slice(0, 160).join(''), entryId: identifier('e') };
    };
    const verifyEntry = async (entry: RoomQueueEntryDocument, session: ClientSession) => {
        if (entry.unavailable || !await touchMedia(entry.mediaTrackId, entry.mediaRevision, session)) return fail('room_media_unavailable', 404);
    };
    const prepare = (room: RoomDocument, entry: RoomQueueEntryDocument, positionMs: number) => {
        room.playbackGeneration = incrementRoomVersion(room.playbackGeneration);
        room.timeline = { entryId: entry.entryId, state: 'preparing', positionMs, anchorServerTimeMs: now() };
        room.preparation = { preparationId: identifier('p'), playbackGeneration: room.playbackGeneration, entryId: entry.entryId,
            mediaRevision: entry.mediaRevision, targetPositionMs: positionMs, deadlineAt: new Date(now() + ROOM_LIMITS.preparationMs),
            cohort: room.members.filter(value => connected(value) && !value.locallyPaused).map(value => ({ membershipId: value.membershipId,
                controllerGeneration: value.controllerGeneration, reportSequence: 0, ready: false })) };
        room.hostSuspended = false;
    };
    const finishPreparation = (room: RoomDocument): boolean => {
        const preparation = room.preparation;
        if (!preparation || !hostPresent(room) || !enabled()) return false;
        preparation.cohort = preparation.cohort.filter(candidate => room.members.some(value => value.membershipId === candidate.membershipId
            && value.controllerGeneration === candidate.controllerGeneration && connected(value) && !value.locallyPaused));
        const ready = preparation.cohort.filter(value => value.ready);
        if (preparation.deadlineAt.getTime() > now() && (ready.length === 0 || ready.length !== preparation.cohort.length)) return false;
        room.timeline.state = ready.length ? 'playing' : 'paused';
        room.timeline.anchorServerTimeMs = now() + (ready.length ? ROOM_LIMITS.startLeadMs : 0);
        room.preparation = null;
        return true;
    };
    const projection = async (room: RoomDocument, actor: RoomActor, session: ClientSession): Promise<RoomSnapshot> => {
        const own = member(room, actor);
        const rows = await profiles().find({ accountId: { $in: room.members.map(value => value.accountId) }, active: true }, { session }).toArray();
        const members = room.members.flatMap(value => {
            const social = rows.find(candidate => candidate.accountId === value.accountId);
            return social ? [{ socialId: social._id, handle: social.handle, alias: social.alias, iconSeed: social._id,
                memberId: value.membershipId, role: value.membershipId === room.hostMembershipId ? 'host' as const : 'guest' as const,
                controllerGeneration: value.controllerGeneration, connected: connected(value), ready: value.readyPlaybackGeneration === room.playbackGeneration }] : [];
        });
        const entry = room.queue.find(value => value.entryId === room.timeline.entryId);
        const result: RoomSnapshot = { protocolVersion: 1, roomId: room._id, epoch: room.epoch, revision: room.revision, serverTimeMs: now(),
            status: room.hostSuspended ? 'suspended' : 'open', controlMode: room.controlMode, controlGeneration: room.controlGeneration,
            hostMemberId: room.hostMembershipId, hostAbsenceDeadlineMs: room.hostAbsentSince ? room.hostAbsentSince.getTime() + ROOM_LIMITS.hostGraceMs : null,
            queueRevision: room.queueRevision, queue: room.queue.map(value => ({ entryId: value.entryId, mediaTrackId: value.mediaTrackId,
                mediaRevision: value.mediaRevision, durationMs: value.durationMs, title: value.title, streamUrl: value.streamUrl, mediaType: 'Audio' })),
            timeline: entry ? { ...room.timeline, playbackGeneration: room.playbackGeneration, mediaRevision: entry.mediaRevision, durationMs: entry.durationMs } : null,
            preparation: room.preparation ? { preparationId: room.preparation.preparationId, playbackGeneration: room.preparation.playbackGeneration,
                entryId: room.preparation.entryId, mediaRevision: room.preparation.mediaRevision, targetPositionMs: room.preparation.targetPositionMs,
                deadlineServerTimeMs: room.preparation.deadlineAt.getTime(), cohortMembershipIds: room.preparation.cohort.map(value => value.membershipId) } : null,
            members, self: { memberId: own.membershipId, controllerGeneration: own.controllerGeneration, isController: controls(own, actor),
                canControl: controls(own, actor) && (room.controlMode === 'everyone' || own.membershipId === room.hostMembershipId) },
            transferOffer: room.transfer && (own.membershipId === room.hostMembershipId || own.membershipId === room.transfer.targetMembershipId)
                ? { offerId: room.transfer.offerId, targetMemberId: room.transfer.targetMembershipId,
                    targetControllerGeneration: room.transfer.targetControllerGeneration, expiresAtMs: room.transfer.expiresAt.getTime() } : null };
        if (Buffer.byteLength(JSON.stringify(result)) > ROOM_LIMITS.snapshotBytes) return fail('room_snapshot_too_large', 503);
        return result;
    };

    /** Attribution is resolved from current membership and active cards, never copied historical profiles. */
    const communityProjection = async (room: RoomDocument, actor: RoomActor, session: ClientSession): Promise<RoomCommunity> => {
        member(room, actor);
        if ((room.songRequests?.length ?? 0) > ROOM_LIMITS.songRequests || room.queue.length > ROOM_LIMITS.queue) return fail('room_snapshot_too_large', 503);
        const rows = await profiles().find({ accountId: { $in: room.members.map(value => value.accountId) }, active: true }, { session }).toArray();
        const cardFor = (membershipId: string | undefined) => {
            const current = room.members.find(value => value.membershipId === membershipId);
            const social = current && rows.find(value => value.accountId === current.accountId && value._id === current.socialId);
            return social ? { socialId: social._id, handle: social.handle, alias: social.alias, iconSeed: social._id } : null;
        };
        const requests: RoomCommunity['requests'] = [];
        for (const request of room.songRequests ?? []) {
            const requestedBy = cardFor(request.requesterMembershipId);
            if (!requestedBy) continue;
            const media = await resolveMedia(request.mediaTrackId, session);
            if (!media || media.mediaRevision !== request.mediaRevision) continue;
            requests.push({ requestId: request.requestId, mediaTrackId: request.mediaTrackId, title: request.title,
                requestedBy, createdAtMs: request.createdAt.getTime() });
        }
        const result: RoomCommunity = { roomId: room._id, epoch: room.epoch, revision: room.revision, requests,
            queueCredits: room.queue.map(entry => ({ entryId: entry.entryId, requestedBy: cardFor(entry.requesterMembershipId) })), events: [] };
        if (Buffer.byteLength(JSON.stringify(result)) > ROOM_LIMITS.snapshotBytes) return fail('room_snapshot_too_large', 503);
        // Required requests and credits keep their budget. Optional notices retain the newest
        // contiguous suffix that fits, measured as encoded bytes rather than character count.
        for (const event of (room.events ?? []).slice(-ROOM_LIMITS.events).reverse()) {
            if (event.expiresAt.getTime() <= now()) continue;
            const actorCard = event.actorMembershipId === null ? null : cardFor(event.actorMembershipId);
            if (event.actorMembershipId !== null && !actorCard) continue;
            result.events.unshift({ eventId: event.eventId, kind: event.kind, actor: actorCard, reaction: event.reaction,
                createdAtMs: event.createdAt.getTime(), expiresAtMs: event.expiresAt.getTime() });
            if (Buffer.byteLength(JSON.stringify(result)) > ROOM_LIMITS.snapshotBytes) { result.events.shift(); break; }
        }
        return result;
    };

    const plan = async (actor: RoomActor, command: RoomCommand, session: ClientSession, epoch: number | null): Promise<Planned> => {
        const own = await profile(actor.userId, session);
        if (command.action === 'create') {
            await cleanSlot(actor.userId, session);
            if (await rooms().countDocuments({ state: 'open' }, { session, limit: ROOM_LIMITS.activeRooms }) >= ROOM_LIMITS.activeRooms) return fail('room_capacity', 429);
            const queue: RoomQueueEntryDocument[] = [];
            for (const id of command.mediaTrackIds) queue.push(await queueEntry(id, session));
            const first = newMember(actor, own._id);
            for (const entry of queue) entry.requesterMembershipId = first.membershipId;
            const room: RoomDocument = { _id: identifier('r'), state: 'open', epoch: epoch!, revision: 1, hostMembershipId: first.membershipId,
                controlMode: 'hostOnly', controlGeneration: 1, queueRevision: 1, playbackGeneration: 1, members: [first], queue, songRequests: [],
                timeline: { entryId: queue[0].entryId, state: 'paused', positionMs: 0, anchorServerTimeMs: now() }, preparation: null,
                transfer: null, hostAbsentSince: null, hostSuspended: false, createdAt: new Date(now()), expiresAt: new Date(now() + ROOM_LIMITS.invitationMs) };
            appendRoomEvent(room, 'joined', first.membershipId, now());
            await projection(room, actor, session);
            return { outcome: 'applied', write: async () => {
                await rooms().insertOne(room, { session });
                await slots().insertOne({ _id: actor.userId, roomId: room._id, membershipId: first.membershipId }, { session });
                await persistRoom(room, session, now());
            } };
        }
        if (command.action === 'acceptInvitation' || command.action === 'declineInvitation') {
            const invitation = await invitations().findOne({ invitationId: command.invitationId, recipientAccountId: actor.userId, generation: command.generation }, { session });
            if (!invitation || invitation.expiresAt.getTime() <= now() || invitation.state !== 'pending') return fail('invitation_unavailable', 404);
            if (command.action === 'declineInvitation') return { outcome: 'applied', write: () => deleteRoomInvitations({ _id: invitation._id }, session, now()) };
            const room = await rooms().findOne({ _id: invitation.roomId }, { session });
            if (!safeRoom(room) || host(room)?.accountId !== invitation.senderAccountId || room.epoch !== epoch) return fail('room_unavailable', 404);
            if (!await friends(actor.userId, invitation.senderAccountId, session)) return fail('invitation_unavailable', 404);
            await noBlocks(actor.userId, room, session);
            if (room.members.length >= ROOM_LIMITS.members) return fail('room_capacity', 429);
            await cleanSlot(actor.userId, session);
            const added = newMember(actor, own._id);
            room.members.push(added);
            appendRoomEvent(room, 'joined', added.membershipId, now());
            await projection(room, actor, session);
            return { outcome: 'applied', write: async () => {
                await slots().insertOne({ _id: actor.userId, roomId: room._id, membershipId: added.membershipId }, { session });
                await deleteRoomInvitations({ _id: invitation._id }, session, now());
                await persistRoom(room, session, now());
            } };
        }
        if (!('roomId' in command)) return fail('invalid_request', 400);
        const room = await rooms().findOne({ _id: command.roomId }, { session });
        if (!safeRoom(room)) return fail('room_unavailable', 404);
        const me = member(room, actor, command.memberId);
        const isHost = me.membershipId === room.hostMembershipId;
        for (const version of [room.revision, room.playbackGeneration, room.controlGeneration, room.queueRevision]) incrementRoomVersion(version);
        const changed = (write: () => Promise<void> = () => persistRoom(room, session, now())): Planned => ({ outcome: 'applied', write });
        const communityChanged = (): Planned => changed();
        if (command.action === 'leave') {
            if (isHost) return fail('host_exit_required');
            return changed(() => removeRoomMember(room, me.membershipId, session, now()));
        }
        if (command.action === 'end') {
            if (!isHost) return fail('room_forbidden', 403);
            return changed(() => closeRoom(room, session, now()));
        }
        if (command.action === 'kick') {
            if (!isHost || !controls(me, actor)) return fail('room_forbidden', 403);
            if (command.targetMemberId === me.membershipId) return fail('host_exit_required');
            if (!room.members.some(value => value.membershipId === command.targetMemberId)) return noop();
            return changed(() => removeRoomMember(room, command.targetMemberId, session, now()));
        }
        if (command.action === 'dismissSongRequest') {
            const request = (room.songRequests ?? []).find(value => value.requestId === command.requestId);
            if (!request) return noop();
            if (request.requesterMembershipId !== me.membershipId && (!isHost || !controls(me, actor))) return fail('room_forbidden', 403);
            room.songRequests = room.songRequests!.filter(value => value.requestId !== command.requestId);
            return communityChanged();
        }
        if (epoch !== null && room.epoch !== epoch) return fail('stale_epoch');
        if (command.action === 'react') {
            if (command.expectedEpoch !== room.epoch) return fail('stale_epoch');
            if (room.hostSuspended) return fail('host_absent');
            const minute = Math.floor(now() / 60_000);
            const budget = await budgets().findOne({ _id: actor.userId }, { session });
            const accountCount = budget?.roomReactionMinute === minute ? budget.roomReactions ?? 0 : 0;
            const roomCount = room.reactionMinute === minute ? room.reactions ?? 0 : 0;
            if (!Number.isSafeInteger(accountCount) || accountCount < 0 || !Number.isSafeInteger(roomCount) || roomCount < 0) return fail('room_unavailable', 503);
            if (accountCount >= ROOM_LIMITS.reactionsPerAccountMinute || roomCount >= ROOM_LIMITS.reactionsPerRoomMinute) return fail('room_reaction_limit', 429);
            room.reactionMinute = minute; room.reactions = roomCount + 1;
            appendRoomEvent(room, 'reaction', me.membershipId, now(), command.reaction);
            return changed(async () => {
                await budgets().updateOne({ _id: actor.userId }, { $set: { accountId: actor.userId,
                    roomReactionMinute: minute, roomReactions: accountCount + 1 } }, { upsert: true, session });
                await persistRoom(room, session, now());
            });
        }
        if (command.action === 'requestSong') {
            if (command.expectedEpoch !== room.epoch) return fail('stale_epoch');
            const pending = room.songRequests ?? [];
            if (pending.some(value => value.requesterMembershipId === me.membershipId && value.mediaTrackId === command.mediaTrackId)) return noop();
            if (pending.length >= ROOM_LIMITS.songRequests
                || pending.filter(value => value.requesterMembershipId === me.membershipId).length >= ROOM_LIMITS.songRequestsPerMember) return fail('room_request_capacity', 429);
            const entry = await queueEntry(command.mediaTrackId, session);
            room.songRequests = [...pending, { requestId: identifier('q'), requesterMembershipId: me.membershipId,
                mediaTrackId: entry.mediaTrackId, mediaRevision: entry.mediaRevision, title: entry.title, createdAt: new Date(now()) }];
            return communityChanged();
        }
        if (command.action === 'takeControl') {
            if (controls(me, actor)) return noop();
            const previousController = { ...me };
            me.controllerSessionId = actor.sessionId; me.controllerClientId = actor.clientId;
            me.controllerGeneration = incrementRoomVersion(me.controllerGeneration); me.lastSeenAt = new Date(now());
            me.connectionPresent = false; me.locallyPaused = false; me.readyPlaybackGeneration = undefined;
            me.readyReportPlaybackGeneration = undefined; me.readyReportSequence = undefined;
            room.transfer = null;
            if (room.preparation) pauseRoom(room, now());
            if (isHost) room.hostAbsentSince = new Date(now());
            return changed(async () => { await suppressRoomListening(room._id, previousController, session); await persistRoom(room, session, now()); });
        }
        if (!controls(me, actor)) return fail('stale_controller');
        if (command.action === 'invite') {
            if (!isHost) return fail('room_forbidden', 403);
            const target = await profiles().findOne({ _id: command.targetSocialId, active: true }, { session });
            if (!target || target.accountId === actor.userId || !await friends(actor.userId, target.accountId, session)) return fail('profile_unavailable', 404);
            await noBlocks(target.accountId, room, session);
            if (room.members.some(value => value.accountId === target.accountId)) return noop();
            if (await invitations().countDocuments({ senderAccountId: actor.userId, state: 'pending', expiresAt: { $gt: new Date(now()) } },
                { session, limit: ROOM_LIMITS.invitations }) >= ROOM_LIMITS.invitations) return fail('room_invitation_capacity', 429);
            const old = await invitations().findOne({ _id: `${room._id}:${target.accountId}` }, { session });
            const invitation: RoomInvitationDocument = { _id: `${room._id}:${target.accountId}`, invitationId: identifier('i'), roomId: room._id,
                senderAccountId: actor.userId, recipientAccountId: target.accountId, generation: old ? incrementRoomVersion(old.generation) : 1,
                state: 'pending', createdAt: new Date(now()), expiresAt: new Date(now() + ROOM_LIMITS.invitationMs) };
            return changed(async () => {
                await invitations().replaceOne({ _id: invitation._id }, invitation, { upsert: true, session });
                await invalidateInvitationAccounts([actor.userId, target.accountId], session, now());
                await persistRoom(room, session, now());
            });
        }
        if (command.action === 'offerTransfer') {
            if (!isHost) return fail('room_forbidden', 403);
            const target = room.members.find(value => value.membershipId === command.targetMemberId);
            if (!target || target === me || !connected(target) || target.controllerGeneration !== command.targetControllerGeneration
                || command.expectedControlGeneration !== room.controlGeneration) return fail('transfer_unavailable');
            room.transfer = { offerId: identifier('t'), hostMembershipId: me.membershipId, controlGeneration: room.controlGeneration,
                targetMembershipId: target.membershipId, targetControllerGeneration: target.controllerGeneration, expiresAt: new Date(now() + ROOM_LIMITS.transferMs) };
            return changed();
        }
        if (command.action === 'cancelTransfer') {
            if (!isHost) return fail('room_forbidden', 403);
            if (!room.transfer || room.transfer.offerId !== command.offerId) return noop();
            room.transfer = null; return changed();
        }
        if (command.action === 'acceptTransfer') {
            const offer = room.transfer;
            if (!offer || offer.offerId !== command.offerId || offer.targetMembershipId !== me.membershipId
                || offer.targetControllerGeneration !== me.controllerGeneration || offer.controlGeneration !== room.controlGeneration
                || offer.hostMembershipId !== room.hostMembershipId || offer.expiresAt.getTime() <= now() || !connected(me) || !hostPresent(room)) return fail('transfer_unavailable');
            const previousHost = host(room)!;
            room.hostMembershipId = me.membershipId; room.controlGeneration = incrementRoomVersion(room.controlGeneration);
            room.transfer = null; room.hostAbsentSince = null;
            if (room.preparation) pauseRoom(room, now());
            appendRoomEvent(room, 'hostChanged', me.membershipId, now());
            return changed(async () => {
                await deleteRoomInvitations({ roomId: room._id, senderAccountId: previousHost.accountId }, session, now());
                await removeRoomMember(room, previousHost.membershipId, session, now());
            });
        }
        if (!('expectedEpoch' in command)) return fail('invalid_request', 400);
        if (command.expectedEpoch !== room.epoch) return fail('stale_epoch');
        if (command.controllerGeneration !== me.controllerGeneration) return fail('stale_controller');
        if (command.expectedControlGeneration !== room.controlGeneration) return fail('stale_permission');
        if (command.action === 'setControlMode') {
            if (!isHost) return fail('room_forbidden', 403);
            if (command.mode === room.controlMode) return noop();
            room.controlMode = command.mode; room.controlGeneration = incrementRoomVersion(room.controlGeneration); room.transfer = null;
            appendRoomEvent(room, 'modeChanged', me.membershipId, now());
            return changed();
        }
        if (command.action === 'acceptSongRequest' || command.action === 'removeQueueEntry' || command.action === 'reorderQueue') {
            if (!isHost) return fail('room_forbidden', 403);
            if (command.expectedPlaybackGeneration !== room.playbackGeneration || command.expectedEntryId !== room.timeline.entryId) return fail('stale_playback');
            if (command.expectedQueueRevision !== room.queueRevision) return fail('stale_queue');
            if (command.action === 'acceptSongRequest') {
                const request = (room.songRequests ?? []).find(value => value.requestId === command.requestId);
                if (!request || !room.members.some(value => value.membershipId === request.requesterMembershipId)) return fail('room_request_unavailable', 404);
                if (room.queue.length >= ROOM_LIMITS.queue) return fail('room_queue_capacity', 429);
                const entry = await queueEntry(request.mediaTrackId, session, request.mediaRevision);
                entry.requesterMembershipId = request.requesterMembershipId;
                room.queue.push(entry);
                room.songRequests = room.songRequests!.filter(value => value.requestId !== request.requestId);
            } else if (command.action === 'removeQueueEntry') {
                if (command.targetEntryId === room.timeline.entryId) return fail('current_entry_required');
                if (!room.queue.some(value => value.entryId === command.targetEntryId)) return fail('entry_unavailable');
                if (room.queue.length <= 1) return fail('room_queue_empty');
                room.queue = room.queue.filter(value => value.entryId !== command.targetEntryId);
            } else {
                if (command.entryIds.length !== room.queue.length || command.entryIds.some(id => !room.queue.some(value => value.entryId === id))) return fail('queue_entries_changed');
                if (command.entryIds.every((id, index) => id === room.queue[index].entryId)) return noop();
                const entries = new Map(room.queue.map(value => [value.entryId, value]));
                room.queue = command.entryIds.map(id => entries.get(id)!);
            }
            room.queueRevision = incrementRoomVersion(room.queueRevision);
            await projection(room, actor, session);
            return communityChanged();
        }
        if (!isHost && room.controlMode !== 'everyone') return fail('room_forbidden', 403);
        if (command.expectedPlaybackGeneration !== room.playbackGeneration || command.expectedEntryId !== room.timeline.entryId) return fail('stale_playback');
        if (['next', 'previous', 'select'].includes(command.action) && command.expectedQueueRevision !== room.queueRevision) return fail('stale_queue');
        if (command.action !== 'pause' && !hostPresent(room)) return fail('host_absent');
        if (command.action === 'pause') {
            if (room.timeline.state === 'paused') return noop();
            pauseRoom(room, now()); return changed();
        }
        let target = room.queue.find(value => value.entryId === room.timeline.entryId)!;
        let position = Math.floor(roomPositionAt(room, now()));
        if (command.action === 'next' || command.action === 'previous') {
            const index = room.queue.indexOf(target) + (command.action === 'next' ? 1 : -1);
            if (!room.queue[index]) return noop();
            target = room.queue[index]; position = 0;
        } else if (command.action === 'select') {
            const selected = room.queue.find(value => value.entryId === command.targetEntryId);
            if (!selected) return fail('entry_unavailable');
            target = selected; position = 0;
        } else if (command.action === 'seek') {
            if (command.positionMs > target.durationMs) return fail('position_out_of_range', 400);
            position = command.positionMs;
        } else if (command.action === 'play') {
            if (room.timeline.state === 'playing') return noop();
            if (position >= target.durationMs) position = 0;
        }
        await verifyEntry(target, session);
        if (target.entryId !== room.timeline.entryId) appendRoomEvent(room, 'trackChanged', me.membershipId, now());
        prepare(room, target, position); return changed();
    };

    const affectedAccounts = async (command: RoomCommand, session: ClientSession) => {
        let roomId = 'roomId' in command ? command.roomId : undefined;
        const result: string[] = [];
        if ('invitationId' in command) {
            const invitation = await invitations().findOne({ invitationId: command.invitationId }, { session });
            if (invitation) { roomId = invitation.roomId; result.push(invitation.senderAccountId, invitation.recipientAccountId); }
        }
        if (roomId) {
            const room = await rooms().findOne({ _id: roomId }, { session });
            if (room) result.push(...room.members.map(value => value.accountId));
        }
        if ('targetSocialId' in command) {
            const target = await profiles().findOne({ _id: command.targetSocialId }, { session });
            if (target) result.push(target.accountId);
        }
        return result;
    };
    const roomAccounts = async (roomId: string, session: ClientSession) => (await rooms().findOne({ _id: roomId }, { session }))?.members.map(value => value.accountId) ?? [];

    const api: RoomApi = {
        async currentRoom(actor) {
            return transaction(actor, async session => {
                const slot = await slots().findOne({ _id: actor.userId }, { session });
                const room = slot ? await rooms().findOne({ _id: slot.roomId }, { session }) : null;
                if (!safeRoom(room) || !room.members.some(value => value.accountId === actor.userId && value.membershipId === slot?.membershipId)) return null;
                await profile(actor.userId, session); return projection(room, actor, session);
            });
        },
        async room(actor, roomId) {
            if (!isRoomIdentifier(roomId)) return fail('invalid_request', 400);
            return transaction(actor, async session => {
                const room = await rooms().findOne({ _id: roomId }, { session });
                if (!safeRoom(room) || !room.members.some(value => value.accountId === actor.userId)) return null;
                await profile(actor.userId, session); return projection(room, actor, session);
            });
        },
        async community(actor, roomId) {
            if (!isRoomIdentifier(roomId)) return fail('invalid_request', 400);
            return transaction(actor, async session => {
                const room = await rooms().findOne({ _id: roomId }, { session });
                if (!safeRoom(room)) return fail('room_unavailable', 404);
                member(room, actor);
                await profile(actor.userId, session);
                return communityProjection(room, actor, session);
            });
        },
        async invitations(actor) {
            return transaction(actor, async session => {
                await profile(actor.userId, session);
                // Filter before filling the preview, while bounding legacy/stale evidence by total admission capacity.
                const values = await invitations().find({ recipientAccountId: actor.userId, state: 'pending', expiresAt: { $gt: new Date(now()) } }, { session })
                    .sort({ createdAt: -1, invitationId: -1 }).limit(ROOM_LIMITS.activeRooms * ROOM_LIMITS.invitations).toArray();
                const result: RoomInvitation[] = [];
                for (const value of values) {
                    const available = await availableInvitation(value, session);
                    if (available) result.push(available.invitation);
                    if (result.length === ROOM_LIMITS.invitations) break;
                }
                return result;
            });
        },
        async invitation(actor, invitationId) {
            if (!isRoomIdentifier(invitationId)) return fail('invalid_request', 400);
            return transaction(actor, async session => {
                const value = await invitations().findOne({ invitationId, recipientAccountId: actor.userId }, { session });
                return (await availableInvitation(value, session))?.invitation ?? null;
            });
        },
        async outgoingInvitations(actor, roomId) {
            if (!isRoomIdentifier(roomId)) return fail('invalid_request', 400);
            return transaction(actor, async session => {
                const room = await rooms().findOne({ _id: roomId }, { session });
                if (!safeRoom(room)) return fail('room_unavailable', 404);
                const own = member(room, actor);
                if (own.membershipId !== room.hostMembershipId || !controls(own, actor)) return fail('room_forbidden', 403);
                await profile(actor.userId, session);
                const values = await invitations().find({ roomId, senderAccountId: actor.userId, state: 'pending', expiresAt: { $gt: new Date(now()) } }, { session })
                    .sort({ createdAt: -1, invitationId: -1 }).limit(ROOM_LIMITS.invitations).toArray();
                const result = [];
                for (const value of values) {
                    const available = await availableInvitation(value, session, room);
                    if (available) result.push({ invitationId: available.invitation.invitationId, generation: available.invitation.generation,
                        recipientSocialId: available.recipientSocialId, expiresAtMs: available.invitation.expiresAtMs });
                }
                return result;
            });
        },
        async eligibleMedia(actor) {
            return transaction(actor, async session => {
                await profile(actor.userId, session);
                const candidates = await db().collection('audioTracks').find({ ...readyAudioStorageFilter,
                    'mediaRepresentation.seekable': true, 'mediaRepresentation.format': 'wav-pcm' },
                    { session, projection: { _id: 1 } }).sort({ _id: -1 }).limit(100).toArray();
                const result: RoomMediaDescriptor[] = [];
                for (const candidate of candidates) {
                    const value = await resolveMedia(candidate._id.toString(), session);
                    if (value) result.push({ ...value, title: [...value.title].slice(0, 160).join('') });
                    if (result.length === 50) break;
                }
                return result;
            });
        },
        async searchMedia(actor, input) {
            if (!input || typeof input !== 'object' || Array.isArray(input)
                || !Object.keys(input).every(key => ['query', 'cursor', 'limit'].includes(key))) return fail('invalid_request', 400);
            const query = normalizeRoomMediaQuery(input.query), limit = input.limit === undefined ? ROOM_MEDIA_DISCOVERY_LIMITS.page : input.limit;
            const cursor = input.cursor;
            if (query === null || !Number.isSafeInteger(limit) || limit < 1 || limit > ROOM_MEDIA_DISCOVERY_LIMITS.maximumPage
                || cursor !== undefined && (typeof cursor !== 'string' || !cursor.length || Buffer.byteLength(cursor) > ROOM_MEDIA_DISCOVERY_LIMITS.cursorBytes)) return fail('invalid_request', 400);
            return transaction(actor, async session => {
                await profile(actor.userId, session);
                let afterId: string | undefined;
                const queryHash = hash(query);
                if (cursor !== undefined) {
                    const parsed = readSocialToken(cursor, secret());
                    if (!exactSocialKeys(parsed, ['audience', 'accountId', 'queryHash', 'afterId', 'expiresAt'])
                        || parsed.audience !== 'room-media-search-v1' || parsed.accountId !== actor.userId || parsed.queryHash !== queryHash
                        || typeof parsed.afterId !== 'string' || !/^[a-f0-9]{24}$/.test(parsed.afterId)
                        || !Number.isSafeInteger(parsed.expiresAt) || Number(parsed.expiresAt) <= now()) return fail('cursor_invalid', 400);
                    afterId = parsed.afterId;
                }
                const candidates = await db().collection('audioTracks').find({ ...readyAudioStorageFilter,
                    'mediaRepresentation.seekable': true, 'mediaRepresentation.format': 'wav-pcm',
                    _id: { $type: 'objectId', ...(afterId ? { $lt: new ObjectId(afterId) } : {}) },
                    ...(query ? { title: { $regex: query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } } : {})
                }, { session, projection: { _id: 1 } }).sort({ _id: -1 }).limit(ROOM_MEDIA_DISCOVERY_LIMITS.candidates + 1).maxTimeMS(2_000).toArray();
                const items: RoomMediaDescriptor[] = [];
                let scanned = 0;
                // A cursor advances past rejected representations too; a sparse page cannot strand older media.
                for (const candidate of candidates.slice(0, ROOM_MEDIA_DISCOVERY_LIMITS.candidates)) {
                    const value = await resolveMedia(candidate._id.toString(), session); scanned++;
                    if (value) items.push(mediaDescriptor(value));
                    if (items.length === limit) break;
                }
                const last = candidates[scanned - 1];
                return { items, nextCursor: last && scanned < candidates.length ? signSocialToken({ audience: 'room-media-search-v1',
                    accountId: actor.userId, queryHash, afterId: last._id.toString(), expiresAt: now() + ROOM_MEDIA_DISCOVERY_LIMITS.cursorMs }, secret()) : null };
            });
        },
        async mediaTrack(actor, mediaTrackId) {
            if (typeof mediaTrackId !== 'string' || !/^[a-f0-9]{24}$/.test(mediaTrackId)) return fail('invalid_request', 400);
            return transaction(actor, async session => {
                await profile(actor.userId, session);
                const value = await resolveMedia(mediaTrackId, session);
                return value ? mediaDescriptor(value) : null;
            });
        },
        async mutate(actor, input) {
            const command = parseRoomCommand(input); if (!command) return fail('invalid_request', 400);
            const original = scope(actor, command.scopeToken);
            const receiptId = hash(JSON.stringify([actor.userId, original.id, command.commandId]));
            const digest = hash(JSON.stringify(['room-v1', Object.keys(command).filter(key => key !== 'scopeToken').sort().map(key => [key, command[key as keyof RoomCommand]])]));
            const safety = ['leave', 'end', 'kick', 'declineInvitation', 'cancelTransfer', 'pause', 'dismissSongRequest'].includes(command.action);
            const result = await transaction(actor, async session => {
                const currentScope = scope(actor, command.scopeToken);
                const receipt = await receipts().findOne({ _id: receiptId }, { session });
                if (receipt) { if (receipt.digest !== digest) return fail('idempotency_conflict'); return { ...receipt.result, replayed: true }; }
                if (!enabled() && !safety) return fail('rooms_disabled', 503);
                const epoch = safety ? null : await authority(session);
                await receipts().deleteMany({ accountId: actor.userId, expiresAt: { $lte: new Date(now()) } }, { session });
                const maximum = SOCIAL_LIMITS.receipts + (safety ? SOCIAL_LIMITS.safetyReceipts : 0);
                if (await receipts().countDocuments({ accountId: actor.userId }, { session, limit: maximum }) >= maximum) return fail('social_limit', 429);
                const budget = await budgets().findOne({ _id: actor.userId }, { session });
                const minute = Math.floor(now() / 60_000); const count = budget?.commandMinute === minute ? budget.commands ?? 0 : 0;
                if (count >= SOCIAL_LIMITS.commandsPerMinute) return fail('social_limit', 429);
                let operation: Planned | undefined;
                let outcome: Omit<SocialOutcome, 'replayed'>;
                try { operation = await plan(actor, command, session, epoch); outcome = { commandId: command.commandId, outcome: operation.outcome }; }
                catch (error) {
                    if (!(error instanceof SocialError) || error.statusCode >= 500 || error.statusCode === 401) throw error;
                    outcome = { commandId: command.commandId, outcome: 'rejected', code: error.code };
                }
                if (operation) await operation.write();
                await budgets().updateOne({ _id: actor.userId }, { $set: { accountId: actor.userId, commandMinute: minute, commands: count + 1 } }, { upsert: true, session });
                await receipts().insertOne({ _id: receiptId, accountId: actor.userId, scopeId: currentScope.id, commandId: command.commandId, digest,
                    result: outcome, scopeExpiresAt: new Date(currentScope.expiresAt), expiresAt: new Date(currentScope.expiresAt + SOCIAL_LIMITS.receiptGraceMs) }, { session });
                return { ...outcome, replayed: false };
            }, session => affectedAccounts(command, session), true);
            if (result.outcome === 'applied' && !result.replayed) notifyRoomChanges();
            return result;
        },
        async heartbeat(actor, input) {
            const report = parseRoomHeartbeat(input); if (!report) return fail('invalid_request', 400);
            let visible = false;
            await transaction(actor, async session => {
                const room = await rooms().findOne({ _id: report.roomId }, { session }); if (!safeRoom(room)) return;
                const me = member(room, actor, report.memberId);
                if (!controls(me, actor) || report.controllerGeneration !== me.controllerGeneration) return fail('stale_controller');
                const epoch = await authority(session);
                const wasConnected = connected(me);
                visible = !wasConnected || me.locallyPaused !== report.locallyPaused;
                if (room.epoch !== epoch) { room.epoch = epoch; pauseRoom(room, now()); visible = true; }
                me.lastSeenAt = new Date(now()); me.connectionPresent = true; me.locallyPaused = report.locallyPaused;
                if (report.locallyPaused) await suppressRoomListening(room._id, me, session);
                if (report.locallyPaused && me.readyPlaybackGeneration != null) { me.readyPlaybackGeneration = undefined; visible = true; }
                if (me.membershipId === room.hostMembershipId && room.hostAbsentSince) { room.hostAbsentSince = null; visible = true; }
                if (room.preparation && finishPreparation(room)) visible = true;
                if (visible) await persistRoom(room, session, now());
                else await rooms().updateOne({ _id: room._id }, { $set: { members: room.members } }, { session });
            }, session => roomAccounts(report.roomId, session));
            if (visible) notifyRoomChanges();
        },
        async ready(actor, input) {
            const report = parseRoomReady(input); if (!report) return fail('invalid_request', 400);
            if (!enabled()) return fail('rooms_disabled', 503);
            let visible = false;
            await transaction(actor, async session => {
                if (!enabled()) return fail('rooms_disabled', 503);
                const epoch = await authority(session);
                const room = await rooms().findOne({ _id: report.roomId }, { session }); if (!safeRoom(room)) return;
                const me = member(room, actor, report.memberId); const preparation = room.preparation;
                if (!controls(me, actor) || report.controllerGeneration !== me.controllerGeneration) return fail('stale_controller');
                if (room.epoch !== epoch || report.expectedEpoch !== epoch) return;
                if (report.preparationId === 'current') {
                    if (preparation || !['playing', 'paused'].includes(room.timeline.state) || report.playbackGeneration !== room.playbackGeneration
                        || report.entryId !== room.timeline.entryId || !connected(me) || me.locallyPaused) return;
                    const entry = room.queue.find(value => value.entryId === room.timeline.entryId);
                    if (!entry || report.mediaRevision !== entry.mediaRevision) return;
                    if (me.readyReportPlaybackGeneration === room.playbackGeneration && report.sequence <= (me.readyReportSequence ?? 0)) return;
                    await verifyEntry(entry, session);
                    const wasReady = me.readyPlaybackGeneration === room.playbackGeneration;
                    me.readyReportPlaybackGeneration = room.playbackGeneration; me.readyReportSequence = report.sequence;
                    me.readyPlaybackGeneration = report.ready ? room.playbackGeneration : undefined;
                    if (wasReady !== report.ready) { await persistRoom(room, session, now()); visible = true; }
                    else await rooms().updateOne({ _id: room._id }, { $set: { members: room.members } }, { session });
                    return;
                }
                if (!preparation || report.preparationId !== preparation.preparationId
                    || report.playbackGeneration !== preparation.playbackGeneration || report.entryId !== preparation.entryId || report.mediaRevision !== preparation.mediaRevision) return;
                const cohort = preparation.cohort.find(value => value.membershipId === me.membershipId && value.controllerGeneration === me.controllerGeneration);
                if (!cohort || report.sequence <= cohort.reportSequence || me.locallyPaused || !connected(me)) return;
                await verifyEntry(room.queue.find(value => value.entryId === preparation.entryId)!, session);
                cohort.reportSequence = report.sequence; cohort.ready = report.ready;
                me.readyReportPlaybackGeneration = room.playbackGeneration; me.readyReportSequence = report.sequence;
                me.readyPlaybackGeneration = report.ready ? room.playbackGeneration : undefined;
                finishPreparation(room); await persistRoom(room, session, now()); visible = true;
            }, session => roomAccounts(report.roomId, session));
            if (visible) notifyRoomChanges();
        },
        async disconnected(actor) {
            let visible = false;
            await transaction(actor, async session => {
                const slot = await slots().findOne({ _id: actor.userId }, { session });
                const room = slot ? await rooms().findOne({ _id: slot.roomId }, { session }) : null; if (!safeRoom(room)) return;
                const me = member(room, actor); if (!controls(me, actor) || !me.connectionPresent) return;
                me.connectionPresent = false;
                me.readyPlaybackGeneration = undefined;
                await suppressRoomListening(room._id, me, session);
                if (me.membershipId === room.hostMembershipId) {
                    room.hostAbsentSince = me.lastSeenAt;
                    if (room.preparation) pauseRoom(room, now());
                }
                await persistRoom(room, session, now()); visible = true;
            });
            if (visible) notifyRoomChanges();
        },
        async sweep() {
            // Capture a timer's observed playback identity before retries: a losing timer
            // must never reinterpret a newly committed user selection as its own target.
            const candidates = await rooms().find({ state: 'open' }).project<Pick<RoomDocument, '_id' | 'epoch' | 'playbackGeneration' | 'queueRevision' | 'timeline'>>(
                { _id: 1, epoch: 1, playbackGeneration: 1, queueRevision: 1, timeline: 1 }).limit(ROOM_LIMITS.activeRooms + 1).toArray();
            if (candidates.length > ROOM_LIMITS.activeRooms) return fail('room_capacity', 503);
            let visible = false;
            for (const candidate of candidates) {
                await options.beforeSweepRoom?.(candidate._id);
                await transaction(null, async session => {
                const epoch = await authority(session);
                const room = await rooms().findOne({ _id: candidate._id }, { session }); if (!room || room.state !== 'open') return;
                if (room.expiresAt.getTime() <= now()) { await closeRoom(room, session, now()); visible = true; return; }
                let changed = false;
                const recentEvents = (room.events ?? []).filter(event => event.expiresAt.getTime() > now());
                if (recentEvents.length !== (room.events?.length ?? 0)) { room.events = recentEvents; changed = true; }
                if (room.epoch !== epoch) { room.epoch = epoch; pauseRoom(room, now()); changed = true; }
                if (!enabled() && room.timeline.state !== 'paused') { pauseRoom(room, now()); changed = true; }
                for (const value of room.members) {
                    const auth = await db().collection('authSessions').findOne({ _id: new ObjectId(value.controllerSessionId), userId: value.accountId,
                        revokedAt: { $exists: false }, expiresAt: { $gt: new Date(now()) } }, { session, projection: { _id: 1 } });
                    if ((!auth || now() - value.lastSeenAt.getTime() >= ROOM_LIMITS.hostGraceMs) && value.connectionPresent) {
                        value.connectionPresent = false; value.readyPlaybackGeneration = undefined; changed = true;
                    }
                }
                const hosting = host(room);
                if (!hosting) { await closeRoom(room, session, now()); visible = true; return; }
                if (!connected(hosting)) {
                    if (!room.hostAbsentSince) { room.hostAbsentSince = hosting.lastSeenAt; changed = true; }
                    if (room.preparation) { pauseRoom(room, now()); changed = true; }
                    const absent = now() - room.hostAbsentSince.getTime();
                    if (absent >= ROOM_LIMITS.hostCloseMs) { await closeRoom(room, session, now()); visible = true; return; }
                    if (absent >= ROOM_LIMITS.hostGraceMs && !room.hostSuspended) { room.hostSuspended = true; pauseRoom(room, now()); changed = true; }
                }
                if (room.transfer && room.transfer.expiresAt.getTime() <= now()) { room.transfer = null; changed = true; }
                const current = room.queue.find(value => value.entryId === room.timeline.entryId);
                if (current && !current.unavailable && (room.timeline.state === 'playing' || room.preparation)) {
                    const media = await resolveMedia(current.mediaTrackId, session);
                    if (!media || media.mediaRevision !== current.mediaRevision) { current.unavailable = true; pauseRoom(room, now()); room.queueRevision = incrementRoomVersion(room.queueRevision); changed = true; }
                }
                if (room.preparation && finishPreparation(room)) changed = true;
                if (enabled() && room.epoch === candidate.epoch && room.playbackGeneration === candidate.playbackGeneration
                    && room.queueRevision === candidate.queueRevision
                    && room.timeline.entryId === candidate.timeline.entryId && candidate.timeline.state === 'playing'
                    && room.timeline.state === 'playing' && current && roomPositionAt(room, now()) >= current.durationMs && hostPresent(room)) {
                    const next = room.queue[room.queue.indexOf(current) + 1];
                    if (next && !next.unavailable) {
                        const media = await touchMedia(next.mediaTrackId, next.mediaRevision, session);
                        if (media) { appendRoomEvent(room, 'trackChanged', null, now()); prepare(room, next, 0); }
                        else { next.unavailable = true; pauseRoom(room, now()); }
                    } else { pauseRoom(room, now()); room.timeline.state = 'ended'; }
                    changed = true;
                }
                if (changed) { await persistRoom(room, session, now()); visible = true; }
                }, session => roomAccounts(candidate._id, session));
            }
            if (visible) notifyRoomChanges();
        }
    };
    return api;
};
