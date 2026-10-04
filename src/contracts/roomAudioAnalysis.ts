/** Administrator-only projection; storage keys, validators and internal lease tokens stay private. */
export interface RoomAudioAnalysisItem {
    mediaTrackId: string;
    title: string;
    status: 'eligible' | 'notAnalyzed' | 'running' | 'retryable' | 'unsupported' | 'unavailable';
    sourceRevision: string;
    attemptId: string;
    updatedAt: string | null;
    reason: RoomAudioAnalysisReason | null;
}

/** Bounded operational reasons never contain filenames, provider responses or decoder diagnostics. */
export type RoomAudioAnalysisReason = 'unsupported_audio' | 'decoder_unavailable' | 'analysis_timeout'
    | 'analysis_failed' | 'storage_unavailable' | 'source_changed' | 'cancelled' | 'interrupted';

/** Each explicit attempt is scoped to the source observed by the administrator. */
export interface RoomAudioAnalysisInput {
    actorId: string;
    mediaTrackId: string;
    sourceRevision: string;
    attemptId: string;
    signal?: AbortSignal;
}

export interface RoomAudioAnalysisPage {
    items: RoomAudioAnalysisItem[];
    nextAfter: string | null;
}

/** A response confirms persisted analysis state, not a change to media bytes or current playback. */
export interface RoomAudioAnalysisOutcome {
    mediaTrackId: string;
    attemptId: string;
    outcome: 'complete' | 'unsupported' | 'failed' | 'cancelled' | 'stale' | 'busy' | 'unknown';
    reason: RoomAudioAnalysisReason | null;
}
