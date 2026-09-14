import type { SocialCard } from './socialV1';
import type { SharedMusicContent } from './socialMusicV1';

/** Ephemeral, opt-in Audio presence is independent of room playback permission and durable activity history. */
export const LISTENING_LIMITS = Object.freeze({ renewMs: 10_000, freshnessMs: 25_000,
    observationAgeMs: 5_000, futureSkewMs: 2_000, reportsPerMinute: 60, query: 50 });

/** Private owner state; publisherRevision remains durable when its visible payload expires. */
export interface OwnListeningState {
    enabled: boolean;
    revision: number;
    publisherRevision: number;
    serverTimeMs: number;
}

export type ListeningAction =
    | { action: 'setListeningSharing'; enabled: boolean; expectedRevision: number }
    | { action: 'claimListening'; clientId: string; expectedPreferenceRevision: number; expectedPublisherRevision: number };

/** Exact admitted playing occurrence; none of these private fields are returned to friends. */
export interface ListeningRoomOccurrence {
    roomId: string;
    epoch: number;
    memberId: string;
    controllerGeneration: number;
    playbackGeneration: number;
    entryId: string;
    mediaRevision: string;
}

export interface ListeningPlayback {
    sourceId: string;
    occurrenceId: string;
    mediaTrackId: string;
    positionMs: number;
    room: ListeningRoomOccurrence | null;
}

/** Stops target a captured occurrence, never whichever device or song happens to be current later. */
export type ListeningReport = {
    clientId: string;
    publicationId: string;
    expectedPreferenceRevision: number;
    expectedPublisherRevision: number;
    sequence: number;
} & (
    | { state: 'playing'; observedAtMs: number; playback: ListeningPlayback }
    | { state: 'stopped'; occurrenceId: string; playbackSequence: number }
);

export interface ListeningReportResult { accepted: boolean; serverTimeMs: number; expiresAtMs: number | null }
export interface FriendListeningStatus {
    peer: SocialCard;
    track: SharedMusicContent & { contentType: 'audioTrack' };
    expiresAtMs: number;
}

const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => value !== null
    && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length
    && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{16,80}$/.test(value);
const roomIdentifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
const integer = (value: unknown, minimum = 0): value is number => Number.isSafeInteger(value) && Number(value) >= minimum;

/** Capture the complete bounded report before transaction retries; do not infer omitted playback state. */
export const parseListeningReport = (input: unknown): ListeningReport | null => {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return null;
    const value = input as Record<string, unknown>;
    const base = ['clientId', 'publicationId', 'expectedPreferenceRevision', 'expectedPublisherRevision', 'sequence', 'state'];
    if (!identifier(value.clientId) || !identifier(value.publicationId) || !integer(value.expectedPreferenceRevision, 1)
        || !integer(value.expectedPublisherRevision, 1) || !integer(value.sequence, 1)) return null;
    if (value.state === 'stopped') return exact(value, [...base, 'occurrenceId', 'playbackSequence']) && identifier(value.occurrenceId)
        && integer(value.playbackSequence, 1) && value.playbackSequence < value.sequence
        ? Object.freeze({ ...value }) as unknown as ListeningReport : null;
    if (value.state !== 'playing' || !exact(value, [...base, 'observedAtMs', 'playback']) || !integer(value.observedAtMs)
        || !exact(value.playback, ['sourceId', 'occurrenceId', 'mediaTrackId', 'positionMs', 'room'])) return null;
    const playback = value.playback;
    if (!identifier(playback.sourceId) || !identifier(playback.occurrenceId) || typeof playback.mediaTrackId !== 'string' || !/^[a-f0-9]{24}$/.test(playback.mediaTrackId)
        || !integer(playback.positionMs) || playback.positionMs > 86_400_000) return null;
    const room = playback.room;
    if (room !== null && (!exact(room, ['roomId', 'epoch', 'memberId', 'controllerGeneration', 'playbackGeneration', 'entryId', 'mediaRevision'])
        || !roomIdentifier(room.roomId) || !roomIdentifier(room.memberId) || !roomIdentifier(room.entryId)
        || typeof room.mediaRevision !== 'string' || !/^mr_[a-f0-9]{32}$/.test(room.mediaRevision)
        || !integer(room.epoch, 1) || !integer(room.controllerGeneration, 1) || !integer(room.playbackGeneration, 1))) return null;
    return Object.freeze({ ...value, playback: Object.freeze({ ...playback, room: room === null ? null : Object.freeze({ ...room }) }) }) as unknown as ListeningReport;
};
