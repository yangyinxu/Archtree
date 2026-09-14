import { createHash } from 'node:crypto';
import { ObjectId, type ClientSession } from 'mongodb';
import { LISTENING_LIMITS, type FriendListeningStatus, type ListeningAction, type ListeningReport, type ListeningReportResult,
    type OwnListeningState } from '../../contracts/listeningV1';
import { ROOM_LIMITS } from '../../contracts/roomV1';
import { SocialError, type SocialActor, type SocialMutationIdentity } from '../../contracts/socialV1';
import { getDb } from '../../infrastructure/database';
import type { ListeningPublicationDocument, ListeningStateDocument } from '../../repositories/social/listeningDocuments';
import type { RoomDocument } from '../../repositories/social/roomDocuments';
import type { SocialBudgetDocument, SocialProfileDocument, SocialRelationshipDocument } from '../../repositories/social/socialDocuments';
import { readyAudioStorageFilter } from '../../utils/audioStorageKey';
import { activeMediaObjectKeyForTrack, activeMediaTypeForTrack } from '../../utils/mediaStorageKey';
import { nextListeningRevision, retireListeningPublication } from './listeningLifecycle';
import { publicContent, resolvePublicContent, type ResolveMusicShareContent } from './musicShareService';

type Plan = { outcome: 'applied' | 'noop'; affected: string[]; write: () => Promise<void> };
const noop = (): Plan => ({ outcome: 'noop', affected: [], write: async () => undefined });
const fail = (code: string, status = 409): never => { throw new SocialError(status, code); };

/** Ephemeral publication work runs inside the existing social session/account transaction. */
export const createListeningService = (options: { now: () => number; enabled: () => boolean;
    resolveContent?: ResolveMusicShareContent; roomsEnabled?: () => boolean }) => {
    const { now, enabled } = options;
    const roomsEnabled = options.roomsEnabled ?? (() => process.env.FINITUDE_ROOMS_ENABLED === 'true');
    const resolveContent = options.resolveContent ?? resolvePublicContent;
    const db = () => getDb()!;
    const states = () => db().collection<ListeningStateDocument>('socialListeningStates');
    const publications = () => db().collection<ListeningPublicationDocument>('socialListeningPublications');
    const profiles = () => db().collection<SocialProfileDocument>('socialProfiles');
    const result = (accepted: boolean, publication?: ListeningPublicationDocument | null): ListeningReportResult => ({ accepted,
        serverTimeMs: now(), expiresAtMs: publication?.visible ? publication.expiresAt.getTime() : null });

    /** A source's active private identity is hashed, never exposed as a URL or public version requirement. */
    const source = async (mediaTrackId: string, session: ClientSession, touch = false) => {
        const filter = { _id: new ObjectId(mediaTrackId), ...readyAudioStorageFilter };
        const track = touch ? (await db().collection('audioTracks').findOneAndUpdate(filter,
            { $inc: { contentReferenceRevision: 1 } }, { session, returnDocument: 'after' })).value
            : await db().collection('audioTracks').findOne(filter, { session });
        if (!track || activeMediaTypeForTrack(track) !== 'audio') return null;
        const key = activeMediaObjectKeyForTrack(track); if (!key) return null;
        const representation = track.mediaRepresentation;
        const fingerprint = createHash('sha256').update(JSON.stringify([key, representation?.revision ?? null,
            representation?.objectKey ?? null, representation?.etag ?? null, representation?.versionId ?? null])).digest('hex');
        return { fingerprint, revision: representation?.revision };
    };

    /** Shared playback claims only the exact ready controller occurrence under a live room authority. */
    const roomCurrent = async (publication: ListeningPublicationDocument, session: ClientSession, touch = false): Promise<boolean> => {
        const playback = publication.playback; const observed = playback?.room;
        if (!observed) return true;
        if (!roomsEnabled()) return false;
        const room = await db().collection<RoomDocument>('socialRooms').findOne({ _id: observed.roomId, state: 'open' }, { session });
        if (!room || room.expiresAt.getTime() <= now() || room.epoch !== observed.epoch || room.hostSuspended
            || room.timeline.state !== 'playing' || room.timeline.anchorServerTimeMs > now() || room.playbackGeneration !== observed.playbackGeneration
            || room.timeline.entryId !== observed.entryId) return false;
        const member = room.members.find(value => value.membershipId === observed.memberId && value.accountId === publication.accountId);
        const entry = room.queue.find(value => value.entryId === observed.entryId);
        if (!member || member.controllerSessionId !== publication.sessionId || member.controllerClientId !== publication.clientId
            || member.controllerGeneration !== observed.controllerGeneration || !member.connectionPresent || member.locallyPaused
            || now() - member.lastSeenAt.getTime() >= ROOM_LIMITS.hostGraceMs || member.readyPlaybackGeneration !== observed.playbackGeneration
            || !entry || entry.unavailable || entry.mediaTrackId !== playback!.mediaTrackId || entry.mediaRevision !== observed.mediaRevision) return false;
        if (!await db().collection('socialAuthority').findOne({ _id: 'rooms-v1', epoch: observed.epoch,
            $expr: { $gt: ['$expiresAt', '$$NOW'] } }, { session, projection: { _id: 1 } })) return false;
        // The report and a concurrent pause/controller change must write the same room document.
        if (touch) await db().collection<RoomDocument>('socialRooms').updateOne({ _id: room._id, revision: room.revision },
            { $inc: { listeningPublicationFence: 1 } }, { session });
        return true;
    };

    const own = async (actor: SocialActor, session: ClientSession): Promise<OwnListeningState> => {
        const value = await states().findOne({ _id: actor.userId }, { session });
        return { enabled: value?.enabled ?? false, revision: value?.revision ?? 0,
            publisherRevision: value?.publisherRevision ?? 0, serverTimeMs: now() };
    };

    return {
        own,
        async plan(actor: SocialActor, action: ListeningAction & SocialMutationIdentity, session: ClientSession): Promise<Plan> {
            const previous = await states().findOne({ _id: actor.userId }, { session });
            if (action.action === 'setListeningSharing') {
                if (action.expectedRevision !== (previous?.revision ?? 0)) return fail('listening_preference_changed');
                if ((previous?.enabled ?? false) === action.enabled) return noop();
                if (action.enabled && !await profiles().findOne({ accountId: actor.userId, active: true }, { session })) return fail('profile_unavailable', 404);
                const state: ListeningStateDocument = { _id: actor.userId, accountId: actor.userId, enabled: action.enabled,
                    revision: nextListeningRevision(previous?.revision ?? 0), publisherRevision: action.enabled ? previous?.publisherRevision ?? 0
                        : nextListeningRevision(previous?.publisherRevision ?? 0), updatedAt: new Date(now()) };
                return { outcome: 'applied', affected: [], write: async () => {
                    await states().replaceOne({ _id: actor.userId }, state, { session, upsert: true });
                    await publications().deleteOne({ _id: actor.userId }, { session });
                } };
            }
            if (!await profiles().findOne({ accountId: actor.userId, active: true }, { session })) return fail('profile_unavailable', 404);
            if (!previous?.enabled) return fail('listening_disabled');
            if (action.expectedPreferenceRevision !== previous.revision) return fail('listening_preference_changed');
            if (action.expectedPublisherRevision !== previous.publisherRevision) return fail('listening_publisher_changed');
            const publisherRevision = nextListeningRevision(previous.publisherRevision);
            const publication: ListeningPublicationDocument = { _id: actor.userId, accountId: actor.userId, sessionId: actor.sessionId,
                clientId: action.clientId, publicationId: action.commandId, preferenceRevision: previous.revision, publisherRevision,
                sequence: 0, playbackSequence: 0, blockedOccurrenceId: null, playback: null, sourceFingerprint: null, observedAtMs: 0, acceptedAtMs: 0, visible: false,
                expiresAt: new Date(now() + LISTENING_LIMITS.freshnessMs) };
            return { outcome: 'applied', affected: [], write: async () => {
                await states().updateOne({ _id: actor.userId }, { $set: { publisherRevision, updatedAt: new Date(now()) } }, { session });
                await publications().replaceOne({ _id: actor.userId }, publication, { session, upsert: true });
            } };
        },
        async report(actor: SocialActor, report: ListeningReport, session: ClientSession): Promise<ListeningReportResult> {
            const state = await states().findOne({ _id: actor.userId }, { session });
            const publication = await publications().findOne({ _id: actor.userId }, { session });
            if (!state?.enabled || !publication || publication.expiresAt.getTime() <= now()
                || state.revision !== report.expectedPreferenceRevision || state.publisherRevision !== report.expectedPublisherRevision
                || publication.preferenceRevision !== state.revision || publication.publisherRevision !== state.publisherRevision
                || publication.publicationId !== report.publicationId || publication.sessionId !== actor.sessionId || publication.clientId !== report.clientId
                || report.sequence <= publication.sequence) return result(false);
            const filter = { _id: actor.userId, publicationId: publication.publicationId, publisherRevision: publication.publisherRevision };
            if (report.state === 'stopped') {
                // A Stop can overtake its Playing. Its captured playing sequence distinguishes that
                // cancellation from a delayed stop belonging to an older, already superseded run.
                const clears = publication.playback?.occurrenceId === report.occurrenceId
                    || report.playbackSequence > (publication.playbackSequence ?? 0);
                await publications().updateOne(filter, { $set: { sequence: report.sequence,
                    ...(clears ? { visible: false, blockedOccurrenceId: report.occurrenceId } : {}) } }, { session });
                return result(true, clears ? null : publication);
            }
            if (!enabled()) return fail('social_disabled', 503);
            if (!await profiles().findOne({ accountId: actor.userId, active: true }, { session })) return result(false);
            const minute = Math.floor(now() / 60_000);
            const budgets = db().collection<SocialBudgetDocument>('socialBudgets');
            const budget = await budgets.findOne({ _id: actor.userId }, { session });
            const count = budget?.listeningReportMinute === minute ? budget.listeningReports ?? 0 : 0;
            if (!Number.isSafeInteger(count) || count < 0) return fail('social_unavailable', 503);
            if (count >= LISTENING_LIMITS.reportsPerMinute) return fail('listening_report_limit', 429);
            await budgets.updateOne({ _id: actor.userId }, { $set: { accountId: actor.userId, listeningReportMinute: minute, listeningReports: count + 1 } }, { session, upsert: true });
            if (report.observedAtMs < now() - LISTENING_LIMITS.observationAgeMs || report.observedAtMs > now() + LISTENING_LIMITS.futureSkewMs) return result(false);
            if (report.playback.occurrenceId === publication.blockedOccurrenceId) return result(false);
            const currentSource = await source(report.playback.mediaTrackId, session, true);
            const sameSource = publication.playback?.sourceId === report.playback.sourceId;
            if (!currentSource || (sameSource && (publication.playback?.mediaTrackId !== report.playback.mediaTrackId
                || publication.sourceFingerprint !== currentSource.fingerprint))) {
                await retireListeningPublication(publication, session, now()); return result(false);
            }
            const next = { ...publication, playback: report.playback, sourceFingerprint: currentSource.fingerprint };
            if ((report.playback.room && report.playback.room.mediaRevision !== currentSource.revision) || !await roomCurrent(next, session, true)) return result(false);
            const sameOccurrence = publication.playback?.occurrenceId === report.playback.occurrenceId;
            if (sameOccurrence && (!sameSource || publication.playback?.mediaTrackId !== report.playback.mediaTrackId
                || JSON.stringify(publication.playback.room) !== JSON.stringify(report.playback.room))) return result(false);
            const progress = !sameOccurrence || (report.playback.positionMs > publication.playback!.positionMs && report.observedAtMs > publication.observedAtMs);
            const due = !sameOccurrence || now() - publication.acceptedAtMs >= LISTENING_LIMITS.renewMs;
            if (!progress || !due) {
                await publications().updateOne(filter, { $set: { sequence: report.sequence } }, { session });
                return result(true, publication);
            }
            next.sequence = report.sequence; next.playbackSequence = report.sequence; next.visible = true; next.observedAtMs = report.observedAtMs; next.acceptedAtMs = now();
            next.expiresAt = new Date(Math.min(now() + LISTENING_LIMITS.freshnessMs, report.observedAtMs + LISTENING_LIMITS.freshnessMs));
            await publications().replaceOne(filter, next, { session });
            return result(true, next);
        },
        async statuses(actor: SocialActor, socialIds: string[], session: ClientSession): Promise<FriendListeningStatus[]> {
            if (!enabled() || !await profiles().findOne({ accountId: actor.userId, active: true }, { session })) return [];
            const rows = await profiles().find({ _id: { $in: socialIds }, accountId: { $ne: actor.userId }, active: true }, { session }).toArray();
            const items: FriendListeningStatus[] = [];
            for (const id of socialIds) {
                const peer = rows.find(value => value._id === id); if (!peer) continue;
                if (!await db().collection<SocialRelationshipDocument>('socialRelationships').findOne({ _id: [actor.userId, peer.accountId].sort().join(':'),
                    state: 'accepted', blockedBy: { $size: 0 } }, { session })) continue;
                const state = await states().findOne({ _id: peer.accountId, enabled: true }, { session });
                const publication = await publications().findOne({ _id: peer.accountId, visible: true, expiresAt: { $gt: new Date(now()) } }, { session });
                if (!state || !publication?.playback || publication.preferenceRevision !== state.revision || publication.publisherRevision !== state.publisherRevision) continue;
                if (!await db().collection('authSessions').findOne({ _id: new ObjectId(publication.sessionId), userId: peer.accountId,
                    revokedAt: { $exists: false }, expiresAt: { $gt: new Date(now()) } }, { session, projection: { _id: 1 } })) continue;
                const currentSource = await source(publication.playback.mediaTrackId, session);
                if (!currentSource || currentSource.fingerprint !== publication.sourceFingerprint
                    || (publication.playback.room && currentSource.revision !== publication.playback.room.mediaRevision)
                    || !await roomCurrent(publication, session)) continue;
                const content = publicContent(await resolveContent('audioTrack', publication.playback.mediaTrackId, session), 'audioTrack', publication.playback.mediaTrackId);
                if (!content) continue;
                items.push({ peer: { socialId: peer._id, handle: peer.handle, alias: peer.alias, iconSeed: peer._id },
                    track: { ...content, contentType: 'audioTrack' }, expiresAtMs: publication.expiresAt.getTime() });
            }
            return items;
        }
    };
};
