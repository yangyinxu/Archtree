import { isMotionPreviewEnabled } from '../../config/motionPreviewRollout';
import {
    MOTION_PREVIEW_MAX_BYTES,
    type MotionPreviewActive
} from '../../models/motionPreview';
import { activeMediaObjectKeyForTrack, activeMediaTypeForTrack } from '../../utils/mediaStorageKey';
import { isMotionPreviewObjectKeyForTrack } from '../../utils/motionPreviewStorageKey';

const revisionPattern = /^pv_[0-9a-f]{32}$/;

/** Accepts only a `pv_<32 hex>` motion-preview revision. */
export const isMotionPreviewRevision = (value: unknown): value is string => (
    typeof value === 'string' && revisionPattern.test(value)
);

/**
 * Returns the public motion preview of an already ready, published, visible MediaTrack, or null.
 * A preview is public only while the feature is enabled, the track's active media is Video, and
 * the preview is complete and bound to that exact active Video object. Pending or cleanup state
 * never hides a valid active preview.
 */
export const publicMotionPreviewForTrack = (
    track: any,
    environment: NodeJS.ProcessEnv = process.env
): MotionPreviewActive | null => {
    if (!isMotionPreviewEnabled(environment)) return null;
    const mediaTrackId = String(track?._id ?? '').trim().toLowerCase();
    if (activeMediaTypeForTrack(track) !== 'video') return null;
    const sourceKey = activeMediaObjectKeyForTrack(track);
    if (!sourceKey) return null;
    const active = track?.motionPreview?.active;
    if (active?.status !== 'ready'
        || active.contentType !== 'video/mp4'
        || !isMotionPreviewObjectKeyForTrack(active.s3Key, mediaTrackId)
        || !Number.isSafeInteger(active.byteLength)
        || active.byteLength <= 0
        || active.byteLength > MOTION_PREVIEW_MAX_BYTES
        || typeof active.etag !== 'string'
        || !/^"[^"\r\n]{1,200}"$/.test(active.etag)
        || !isMotionPreviewRevision(active.revision)
        || active.source?.s3Key !== sourceKey) {
        return null;
    }
    return active as MotionPreviewActive;
};
