import type { SoundtrackVideoAsset } from '../models/soundtrackVideoAsset';

const objectIdPattern = /^[0-9a-f]{24}$/;

/** Accepts only a versioned video key whose namespace is bound to one MediaTrack. */
export const isVideoObjectKeyForTrack = (value: unknown, audioTrackId: string) => {
    if (typeof value !== 'string') return false;
    const normalizedTrackId = String(audioTrackId ?? '').trim().toLowerCase();
    if (!objectIdPattern.test(normalizedTrackId)) return false;
    const match = /^video\/([0-9a-f]{24})\/([0-9a-f]{24})$/i.exec(value);
    return Boolean(match && match[1].toLowerCase() === normalizedTrackId);
};

/** Returns the public key only for a complete, identity-bound ready video. */
export const readyVideoObjectKey = (track: any) => {
    const audioTrackId = String(track?._id ?? '').trim().toLowerCase();
    if (track?.mediaType === 'video') {
        return isVideoObjectKeyForTrack(track?.s3Key, audioTrackId)
            && String(track?.contentType ?? '').toLowerCase() === 'video/mp4'
            ? String(track.s3Key)
            : null;
    }
    if (track?.mediaType === 'audio') return null;
    const active = track?.videoAsset?.active;
    if (active?.status !== 'ready'
        || active?.contentType !== 'video/mp4'
        || !Number.isSafeInteger(active?.byteLength)
        || active.byteLength <= 0
        || !isVideoObjectKeyForTrack(active?.s3Key, audioTrackId)) {
        return null;
    }
    return active.s3Key as string;
};

/** Enumerates every exact video key retained by one lifecycle record. */
export const videoObjectKeysForTrack = (
    videoAsset: SoundtrackVideoAsset | null | undefined,
    audioTrackId: string
) => {
    if (!videoAsset) return [];
    const candidates = [
        videoAsset.active?.s3Key,
        videoAsset.pending?.s3Key,
        videoAsset.cleanup?.s3Key
    ].filter((value): value is string => Boolean(value));
    const keys = [...new Set(candidates)];
    for (const key of keys) {
        if (!isVideoObjectKeyForTrack(key, audioTrackId)) {
            throw new Error('MediaTrack video storage key is missing or invalid.');
        }
    }
    return keys;
};
