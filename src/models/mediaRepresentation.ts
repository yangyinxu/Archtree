export const ROOM_AUDIO_ANALYSIS_VERSION = 2;

/** Private evidence bound to one uploaded object; never serialize this storage record. */
export interface MediaRepresentation {
    revision: string;
    objectKey: string;
    byteLength: number;
    durationMs: number | null;
    seekable: boolean;
    format: 'wav-pcm' | 'mp3' | 'm4a-aac' | 'unsupported';
    analysisVersion?: number;
    analysisFailure?: 'decoder_unavailable' | 'analysis_timeout' | 'analysis_failed';
    etag: string | null;
    versionId: string | null;
}

/** Public room media identity; its URL contains no storage key or authorization token. */
export interface RoomAudioRepresentation {
    mediaTrackId: string;
    title: string;
    mediaRevision: string;
    durationMs: number;
    streamUrl: string;
    mediaType: 'Audio';
}
