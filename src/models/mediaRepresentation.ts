/** Private evidence bound to one uploaded object; never serialize this storage record. */
export interface MediaRepresentation {
    revision: string;
    objectKey: string;
    byteLength: number;
    durationMs: number | null;
    seekable: boolean;
    format: 'wav-pcm' | 'unsupported';
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
