import {
    parseRoomPlaybackPrototypeCommand,
    parseRoomPlaybackPrototypeSnapshot,
    roomPlaybackTargetMs,
    type RoomPlaybackControlMode,
    type RoomPlaybackPrototypeCommand,
    type RoomPlaybackPrototypeSnapshot
} from '../../contracts/roomPlaybackPrototype';

/** Already-resolved synthetic queue identity; production must use fenced ready media. */
export type PrototypeQueueEntry = Pick<RoomPlaybackPrototypeSnapshot,
    'entryId' | 'mediaTrackId' | 'mediaRevision' | 'mediaType' | 'durationMs'>;

const queueEntryKeys = ['entryId', 'mediaTrackId', 'mediaRevision', 'mediaType', 'durationMs'] as const;

/** Queue data can supply media identity only, never room authority or timeline fields. */
const projectQueueEntry = (entry: PrototypeQueueEntry): PrototypeQueueEntry => ({
    entryId: entry.entryId, mediaTrackId: entry.mediaTrackId, mediaRevision: entry.mediaRevision,
    mediaType: entry.mediaType, durationMs: entry.durationMs
});

export interface PrototypeParticipant {
    memberId: string;
    controllerGeneration: number;
}

/** Account/session authentication and membership persistence are deliberately not implemented here. */
export interface PrototypeRoomState {
    snapshot: RoomPlaybackPrototypeSnapshot;
    queue: readonly PrototypeQueueEntry[];
    participants: readonly PrototypeParticipant[];
    hostMemberId: string;
    hostPresent: boolean;
    controlMode: RoomPlaybackControlMode;
}

export type PrototypeCommandFailure = 'invalid_command' | 'forbidden' | 'stale_controller'
    | 'stale_epoch' | 'stale_permission' | 'stale_playback' | 'stale_queue'
    | 'host_absent' | 'entry_unavailable' | 'position_out_of_range' | 'version_exhausted';

export type PrototypeTransition =
    | { status: 'accepted' | 'noop'; state: PrototypeRoomState }
    | { status: 'rejected'; reason: PrototypeCommandFailure; state: PrototypeRoomState };

/** Copies every mutable boundary so neither a fixture nor an intent can rewrite committed state. */
const copyState = (state: PrototypeRoomState): PrototypeRoomState => ({
    ...state,
    snapshot: { ...state.snapshot },
    queue: state.queue.map(entry => ({ ...entry })),
    participants: state.participants.map(member => ({ ...member }))
});

const validState = (state: PrototypeRoomState): boolean => {
    if (!parseRoomPlaybackPrototypeSnapshot(state.snapshot)
        || !['hostOnly', 'everyone'].includes(state.controlMode)
        || typeof state.hostPresent !== 'boolean'
        || state.queue.length < 1 || state.queue.length > 100
        || state.participants.length < 1 || state.participants.length > 8) return false;
    if (new Set(state.queue.map(entry => entry.entryId)).size !== state.queue.length
        || new Set(state.participants.map(member => member.memberId)).size !== state.participants.length) return false;
    if (!state.participants.every(member => /^[A-Za-z0-9_-]{1,80}$/.test(member.memberId)
        && Number.isSafeInteger(member.controllerGeneration) && member.controllerGeneration >= 1)
        || !state.participants.some(member => member.memberId === state.hostMemberId)) return false;
    if (!state.queue.every(entry => Object.keys(entry).length === queueEntryKeys.length
        && queueEntryKeys.every(key => Object.prototype.hasOwnProperty.call(entry, key))
        && parseRoomPlaybackPrototypeSnapshot({
            ...state.snapshot, ...projectQueueEntry(entry), positionMs: 0
        }))) return false;
    const current = state.queue.find(entry => entry.entryId === state.snapshot.entryId);
    return Boolean(current && ['mediaTrackId', 'mediaRevision', 'mediaType', 'durationMs']
        .every(key => current[key as keyof PrototypeQueueEntry] === state.snapshot[key as keyof RoomPlaybackPrototypeSnapshot]));
};

/**
 * Pure arbitration spike for two-mode playback. Callers preserve the original
 * envelope when retrying a transaction; this function never rebases intent.
 * An accepted selection enters preparation, not immediate unverified playback.
 */
export const transitionPrototypeRoom = (
    current: PrototypeRoomState,
    actor: PrototypeParticipant,
    input: unknown,
    serverNowMs: number
): PrototypeTransition => {
    const state = copyState(current);
    const reject = (reason: PrototypeCommandFailure): PrototypeTransition => ({ status: 'rejected', reason, state });
    const command = parseRoomPlaybackPrototypeCommand(input);
    if (!validState(state) || !command || !Number.isSafeInteger(serverNowMs) || serverNowMs < 0) return reject('invalid_command');
    const member = state.participants.find(candidate => candidate.memberId === actor.memberId);
    if (!member) return reject('forbidden');
    if (member.controllerGeneration !== actor.controllerGeneration) return reject('stale_controller');
    const snapshot = state.snapshot;
    if (command.expectedEpoch !== snapshot.epoch) return reject('stale_epoch');
    if (command.expectedControlGeneration !== snapshot.controlGeneration) return reject('stale_permission');
    const host = actor.memberId === state.hostMemberId;
    if ((!host && state.controlMode === 'hostOnly') || (command.action === 'setControlMode' && !host)) return reject('forbidden');
    if (command.action === 'setControlMode') {
        if (state.controlMode === command.mode) return { status: 'noop', state };
        if (snapshot.revision === Number.MAX_SAFE_INTEGER || snapshot.controlGeneration === Number.MAX_SAFE_INTEGER) return reject('version_exhausted');
        return { status: 'accepted', state: {
            ...state, controlMode: command.mode,
            snapshot: { ...snapshot, revision: snapshot.revision + 1, controlGeneration: snapshot.controlGeneration + 1 }
        } };
    }
    if (command.expectedPlaybackGeneration !== snapshot.playbackGeneration || command.expectedEntryId !== snapshot.entryId) return reject('stale_playback');
    if (['next', 'previous', 'select'].includes(command.action)
        && command.expectedQueueRevision !== snapshot.queueRevision) return reject('stale_queue');
    if (command.action !== 'pause' && !state.hostPresent) return reject('host_absent');
    let target = state.queue.find(entry => entry.entryId === snapshot.entryId)!;
    let positionMs = Math.floor(roomPlaybackTargetMs(snapshot, serverNowMs));
    if (command.action === 'next' || command.action === 'previous') {
        const offset = command.action === 'next' ? 1 : -1;
        const candidate = state.queue[state.queue.findIndex(entry => entry.entryId === snapshot.entryId) + offset];
        if (!candidate) return { status: 'noop', state };
        target = candidate;
        positionMs = 0;
    } else if (command.action === 'select') {
        const candidate = state.queue.find(entry => entry.entryId === command.targetEntryId);
        if (!candidate) return reject('entry_unavailable');
        target = candidate;
        positionMs = 0;
    } else if (command.action === 'seek') {
        if (command.positionMs > snapshot.durationMs) return reject('position_out_of_range');
        positionMs = command.positionMs;
    } else if (command.action === 'pause' && snapshot.state === 'paused') {
        return { status: 'noop', state };
    } else if (command.action === 'play' && snapshot.state === 'playing') {
        return { status: 'noop', state };
    }
    if (snapshot.revision === Number.MAX_SAFE_INTEGER || snapshot.playbackGeneration === Number.MAX_SAFE_INTEGER) return reject('version_exhausted');
    return { status: 'accepted', state: { ...state, snapshot: {
        ...snapshot, ...projectQueueEntry(target), positionMs, anchorServerTimeMs: serverNowMs,
        state: command.action === 'pause' ? 'paused' : 'preparing',
        revision: snapshot.revision + 1, playbackGeneration: snapshot.playbackGeneration + 1
    } } };
};

export type PrototypeReceiptResult = {
    status: 'accepted' | 'noop' | 'duplicate' | 'rejected';
    reason?: PrototypeCommandFailure | 'idempotency_conflict' | 'scope_expired' | 'receipt_capacity';
    snapshot?: RoomPlaybackPrototypeSnapshot;
};

/**
 * Bounded in-memory laboratory authority, not a durable repository. Its scope
 * deadline is supplied by the harness; it has no production session/ticket API.
 * Receipts contain outcomes, never snapshots from which removed users can read.
 */
export class RoomPlaybackPrototypeAuthority {
    private current: PrototypeRoomState;
    private readonly receipts = new Map<string, { digest: string; result: PrototypeReceiptResult }>();

    constructor(initial: PrototypeRoomState, private readonly scopeExpiresAtMs: number) {
        if (!validState(initial) || !Number.isSafeInteger(scopeExpiresAtMs) || scopeExpiresAtMs < 0) throw new Error('Invalid synthetic room.');
        this.current = copyState(initial);
    }

    /** Returns a copy for assertions; production projections must use per-viewer authorization. */
    inspect(): PrototypeRoomState { return copyState(this.current); }

    /** Models atomic admission; there is no await between expected-state check and commit. */
    submit(actor: PrototypeParticipant, input: unknown, serverNowMs: number): PrototypeReceiptResult {
        const command = parseRoomPlaybackPrototypeCommand(input);
        if (!command || !Number.isSafeInteger(serverNowMs) || serverNowMs < 0) return { status: 'rejected', reason: 'invalid_command' };
        if (serverNowMs >= this.scopeExpiresAtMs) return { status: 'rejected', reason: 'scope_expired' };
        const member = this.current.participants.find(candidate => candidate.memberId === actor.memberId);
        if (!member) return { status: 'rejected', reason: 'forbidden' };
        if (member.controllerGeneration !== actor.controllerGeneration) return { status: 'rejected', reason: 'stale_controller' };
        const key = JSON.stringify([actor.memberId, command.commandId]);
        const digest = JSON.stringify(Object.keys(command).sort().map(key => [key, command[key as keyof RoomPlaybackPrototypeCommand]]));
        const receipt = this.receipts.get(key);
        if (receipt) return receipt.digest === digest
            ? { ...receipt.result, status: receipt.result.status === 'rejected' ? 'rejected' : 'duplicate' }
            : { status: 'rejected', reason: 'idempotency_conflict' };
        if (this.receipts.size >= 1_000) return { status: 'rejected', reason: 'receipt_capacity' };
        const transition = transitionPrototypeRoom(this.current, actor, command, serverNowMs);
        const result: PrototypeReceiptResult = transition.status === 'rejected'
            ? { status: 'rejected', reason: transition.reason }
            : { status: transition.status };
        this.receipts.set(key, { digest, result });
        if (transition.status !== 'rejected') this.current = transition.state;
        return transition.status === 'rejected' ? { ...result } : { ...result, snapshot: { ...this.current.snapshot } };
    }
}
