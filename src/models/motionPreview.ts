/**
 * Lifecycle state for an optional, decorative motion preview of a Video MediaTrack. A preview is a
 * short muted MP4 derived from the active Video; it is never a playable representation, and it is
 * public only while bound to the exact active Video object it was made from.
 */

/** The exact active Video object a preview was made from. Video keys are never reused. */
export interface MotionPreviewSource {
    s3Key: string;
}

/** The one public preview object, with the exact evidence needed to serve and delete it. */
export interface MotionPreviewActive {
    status: 'ready';
    /** Random `pv_<32 hex>` identity, changed by every promotion. */
    revision: string;
    s3Key: string;
    versionId: string | null;
    etag: string;
    byteLength: number;
    contentType: 'video/mp4';
    durationMs: number;
    width: number;
    height: number;
    sha256: string;
    source: MotionPreviewSource;
    /** The administrator who last uploaded the clip; not shared-catalog provenance. */
    updatedBy: string;
    updatedAt: Date;
}

/** An upload whose S3 outcome must be known before its key can be reused or deleted. */
export interface MotionPreviewPending {
    status: 'uploading' | 'failed';
    s3Key: string;
    versionId: string | null;
    /** Set until the PUT outcome is recorded; resolved only through an exact HEAD, never by key alone. */
    outcomeUnknown: boolean;
    source: MotionPreviewSource;
    /** A live lease blocks recovery so a slow upload is never deleted underneath itself. */
    leaseUntil: Date;
    updatedAt: Date;
    error: string | null;
}

/** A detached object kept traceable until its exact version is deleted. */
export interface MotionPreviewCleanup {
    status: 'pending' | 'deleteFailed';
    s3Key: string;
    versionId: string | null;
    reason: 'replaced' | 'stale' | 'removed';
    updatedAt: Date;
    error: string | null;
}

/** Embedded on the MediaTrack; every write is a compare-and-set on `revision`. */
export interface MotionPreviewState {
    active: MotionPreviewActive | null;
    pending: MotionPreviewPending | null;
    cleanup: MotionPreviewCleanup | null;
    revision: number;
}

export const MOTION_PREVIEW_MAX_BYTES = 4 * 1024 * 1024;
export const MOTION_PREVIEW_MAX_DURATION_MS = 8_500;
export const MOTION_PREVIEW_MAX_WIDTH = 854;
export const MOTION_PREVIEW_MAX_HEIGHT = 480;
export const MOTION_PREVIEW_LEASE_MS = 10 * 60 * 1000;
