/** Retains lifecycle evidence from the superseded optional-video MediaTrack prototype. */
export interface SoundtrackVideoActiveAsset {
    status: 'ready' | 'deleting' | 'deleteFailed';
    s3Key: string;
    contentType: 'video/mp4';
    byteLength: number;
    durationSeconds: number | null;
    originalFileName: string;
    updatedAt: Date;
    error: string | null;
}

/** Retains an upload key until its S3 outcome can be reconciled safely. */
export interface SoundtrackVideoPendingAsset {
    status: 'uploading' | 'failed';
    s3Key: string;
    updatedAt: Date;
    error: string | null;
}

/** Retains a detached replacement key until cleanup is confirmed. */
export interface SoundtrackVideoCleanupAsset {
    status: 'pending' | 'deleteFailed';
    s3Key: string;
    updatedAt: Date;
    error: string | null;
}

/** Keeps active, pending, and detached objects independently traceable. */
export interface SoundtrackVideoAsset {
    active: SoundtrackVideoActiveAsset | null;
    pending: SoundtrackVideoPendingAsset | null;
    cleanup: SoundtrackVideoCleanupAsset | null;
    revision: number;
}
