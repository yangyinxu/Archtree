import { ObjectId } from 'mongodb';

import type { MotionPreviewState } from '../models/motionPreview';

const objectIdPattern = /^[0-9a-f]{24}$/;

/** Creates a never-reused key in the motion-preview namespace owned by one MediaTrack. */
export const createMotionPreviewObjectKey = (mediaTrackId: string) => (
    `motion-preview/${String(mediaTrackId).trim().toLowerCase()}/${new ObjectId().toHexString()}`
);

/** Accepts only a motion-preview key whose namespace is bound to the given MediaTrack. */
export const isMotionPreviewObjectKeyForTrack = (value: unknown, mediaTrackId: string) => {
    if (typeof value !== 'string') return false;
    const normalizedTrackId = String(mediaTrackId ?? '').trim().toLowerCase();
    if (!objectIdPattern.test(normalizedTrackId)) return false;
    const match = /^motion-preview\/([0-9a-f]{24})\/([0-9a-f]{24})$/.exec(value);
    return Boolean(match && match[1] === normalizedTrackId);
};

/** Recognizes a well-formed key in the owned motion-preview namespace. */
export const isMotionPreviewStorageObjectKey = (key: string) => /^motion-preview\/[0-9a-f]{24}\/[0-9a-f]{24}$/.test(key);

/** Audits malformed keys inside motion-preview/ instead of treating them as unrelated data. */
export const isMotionPreviewCandidateKey = (key: string) => key.startsWith('motion-preview/');

/**
 * Enumerates every exact preview object a lifecycle record still owns, with its known version.
 * Throws on a foreign or malformed key so deletion fails closed instead of skipping evidence.
 */
export const motionPreviewLifecycleKeys = (
    state: MotionPreviewState | null | undefined,
    mediaTrackId: string
) => {
    if (!state) return [];
    const entries = [state.active, state.pending, state.cleanup]
        .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry?.s3Key))
        .map((entry) => ({ key: entry.s3Key, versionId: entry.versionId ?? null }));
    const unique = new Map<string, string | null>();
    for (const entry of entries) {
        if (!isMotionPreviewObjectKeyForTrack(entry.key, mediaTrackId)) {
            throw new Error('MediaTrack motion preview storage key is missing or invalid.');
        }
        unique.set(entry.key, unique.get(entry.key) ?? entry.versionId);
    }
    return [...unique].map(([key, versionId]) => ({ key, versionId }));
};
