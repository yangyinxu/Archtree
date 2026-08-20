import { isAudioObjectKeyForTrack } from './audioStorageKey';
import { isVideoObjectKeyForTrack, readyVideoObjectKey } from './videoStorageKey';

export type MediaType = 'audio' | 'video';

/** Normalizes persisted media kind while treating pre-migration rows as Audio. */
export const persistedMediaType = (value: unknown): MediaType => (
    value === 'video' ? 'video' : 'audio'
);

/** Resolves the one externally active kind, including the superseded local prototype. */
export const activeMediaTypeForTrack = (track: any): MediaType => {
    if (track?.mediaType === 'audio' || track?.mediaType === 'video') {
        return track.mediaType;
    }
    return readyVideoObjectKey(track) ? 'video' : 'audio';
};

/** Accepts only the S3 namespace assigned to the recorded kind and MediaTrack ID. */
export const isMediaObjectKeyForTrack = (
    value: unknown,
    mediaTrackId: string,
    mediaType: MediaType
) => mediaType === 'video'
    ? isVideoObjectKeyForTrack(value, mediaTrackId)
    : isAudioObjectKeyForTrack(value, mediaTrackId);

/** Resolves the single public object; legacy optional-video state is read-only migration input. */
export const activeMediaObjectKeyForTrack = (track: any): string | null => {
    const mediaTrackId = String(track?._id ?? '').trim().toLowerCase();
    const mediaType = activeMediaTypeForTrack(track);
    if (track?.mediaType == null && mediaType === 'video') {
        return readyVideoObjectKey(track);
    }
    return isMediaObjectKeyForTrack(track?.s3Key, mediaTrackId, mediaType)
        ? String(track.s3Key)
        : null;
};

/** Provides a safe response type without trusting S3 metadata or arbitrary persisted input. */
export const activeMediaContentTypeForTrack = (track: any): string => {
    const mediaType = activeMediaTypeForTrack(track);
    if (track?.mediaType == null && mediaType === 'video') return 'video/mp4';
    const value = String(track?.contentType ?? '').trim().toLowerCase();
    if (mediaType === 'video') return value === 'video/mp4' ? value : 'video/mp4';
    return value.startsWith('audio/') ? value : 'audio/mpeg';
};

/** Maps each top-level lifecycle key to the kind needed for exact cleanup validation. */
export const topLevelMediaLifecycleKeys = (track: any, mediaTrackId: string) => {
    const activeType = persistedMediaType(track?.mediaType);
    const entries: Array<{ phase: 'active' | 'pending' | 'cleanup'; key: string; mediaType: MediaType }> = [];
    const candidates = [
        { phase: 'active' as const, key: track?.s3Key, mediaType: activeType },
        {
            phase: 'pending' as const,
            key: track?.pendingS3Key,
            mediaType: persistedMediaType(track?.pendingMediaType ?? activeType)
        },
        {
            phase: 'cleanup' as const,
            key: track?.storageCleanupS3Key,
            mediaType: persistedMediaType(track?.storageCleanupMediaType ?? 'audio')
        }
    ];
    for (const candidate of candidates) {
        if (!candidate.key) continue;
        if (!isMediaObjectKeyForTrack(candidate.key, mediaTrackId, candidate.mediaType)) {
            throw new Error('MediaTrack storage key is missing, wrong-kind, or invalid.');
        }
        entries.push({ ...candidate, key: String(candidate.key) });
    }
    return entries;
};
