/**
 * Stage 1 synthetic transport contract. This is not a published social API and
 * must not be used as an authorization boundary or production room DTO.
 */
export interface RoomPlaybackPrototypeSnapshot {
    protocolVersion: 1;
    roomId: string;
    epoch: number;
    revision: number;
    controlGeneration: number;
    queueRevision: number;
    playbackGeneration: number;
    entryId: string;
    mediaTrackId: string;
    mediaRevision: string;
    mediaType: 'audio' | 'video';
    durationMs: number;
    positionMs: number;
    anchorServerTimeMs: number;
    state: 'preparing' | 'paused' | 'playing' | 'ended';
}

export type RoomPlaybackControlMode = 'hostOnly' | 'everyone';

/** Immutable observed versions keep a delayed relative action tied to its intent. */
export interface RoomPlaybackPrototypeCommandBase {
    commandId: string;
    expectedEpoch: number;
    expectedControlGeneration: number;
    expectedPlaybackGeneration: number;
    expectedQueueRevision: number;
    expectedEntryId: string;
}

export type RoomPlaybackPrototypeCommand = RoomPlaybackPrototypeCommandBase & (
    | { action: 'next' | 'previous' | 'play' | 'pause' }
    | { action: 'select'; targetEntryId: string }
    | { action: 'seek'; positionMs: number }
    | { action: 'setControlMode'; mode: RoomPlaybackControlMode }
);

const identifier = (value: unknown): value is string =>
    typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
const integer = (value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
    Object.keys(value).length === keys.length
    && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));

const snapshotKeys = [
    'protocolVersion', 'roomId', 'epoch', 'revision', 'controlGeneration',
    'queueRevision', 'playbackGeneration', 'entryId', 'mediaTrackId',
    'mediaRevision', 'mediaType', 'durationMs', 'positionMs', 'anchorServerTimeMs', 'state'
] as const;

/** Fully validates a small projection before it can reach a player or fixture cache. */
export const parseRoomPlaybackPrototypeSnapshot = (value: unknown): RoomPlaybackPrototypeSnapshot | null => {
    if (!record(value) || !exactKeys(value, snapshotKeys) || value.protocolVersion !== 1) return null;
    if (!identifier(value.roomId) || !identifier(value.entryId) || !identifier(value.mediaRevision)) return null;
    if (typeof value.mediaTrackId !== 'string' || !/^[0-9a-f]{24}$/.test(value.mediaTrackId)) return null;
    if (!['epoch', 'revision', 'controlGeneration', 'queueRevision', 'playbackGeneration']
        .every(key => integer(value[key], 1))) return null;
    if (!integer(value.durationMs, 1, 86_400_000) || !integer(value.positionMs, 0, value.durationMs)
        || !integer(value.anchorServerTimeMs, 0)) return null;
    if (value.mediaType !== 'audio' && value.mediaType !== 'video') return null;
    if (typeof value.state !== 'string' || !['preparing', 'paused', 'playing', 'ended'].includes(value.state)) return null;
    return Object.freeze({ ...value }) as unknown as RoomPlaybackPrototypeSnapshot;
};

const commandKeys = [
    'commandId', 'expectedEpoch', 'expectedControlGeneration', 'expectedPlaybackGeneration',
    'expectedQueueRevision', 'expectedEntryId', 'action'
] as const;

/** Rejects extra identity fields and freezes versions before any asynchronous work. */
export const parseRoomPlaybackPrototypeCommand = (value: unknown): RoomPlaybackPrototypeCommand | null => {
    if (!record(value) || typeof value.action !== 'string'
        || !identifier(value.commandId) || !identifier(value.expectedEntryId)) return null;
    if (!['expectedEpoch', 'expectedControlGeneration', 'expectedPlaybackGeneration', 'expectedQueueRevision']
        .every(key => integer(value[key], 1))) return null;
    const extra = value.action === 'select' ? ['targetEntryId']
        : value.action === 'seek' ? ['positionMs'] : value.action === 'setControlMode' ? ['mode'] : [];
    if (!exactKeys(value, [...commandKeys, ...extra])) return null;
    if (value.action === 'select' && !identifier(value.targetEntryId)) return null;
    if (value.action === 'seek' && !integer(value.positionMs, 0, 86_400_000)) return null;
    if (value.action === 'setControlMode' && value.mode !== 'hostOnly' && value.mode !== 'everyone') return null;
    if (!['next', 'previous', 'play', 'pause', 'select', 'seek', 'setControlMode'].includes(value.action)) return null;
    return Object.freeze({ ...value }) as unknown as RoomPlaybackPrototypeCommand;
};

/** Extrapolates only an accepted playing timeline; paused/preparing clocks stay fixed. */
export const roomPlaybackTargetMs = (snapshot: RoomPlaybackPrototypeSnapshot, estimatedServerNowMs: number): number => {
    if (!Number.isFinite(estimatedServerNowMs)) return snapshot.positionMs;
    const elapsed = snapshot.state === 'playing'
        ? Math.max(0, estimatedServerNowMs - snapshot.anchorServerTimeMs) : 0;
    return Math.min(snapshot.durationMs, snapshot.positionMs + elapsed);
};
