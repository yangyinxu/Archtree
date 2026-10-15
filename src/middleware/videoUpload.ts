import multer from 'multer';

import { audioDiskStorage } from './audioUpload';

const configuredMaxVideoUploadMb = Number(process.env.MAX_VIDEO_UPLOAD_MB ?? 512);

export const maxVideoUploadMb = Number.isFinite(configuredMaxVideoUploadMb)
    && configuredMaxVideoUploadMb > 0
    ? Math.min(1024, Math.floor(configuredMaxVideoUploadMb))
    : 512;

/** Reuses the bounded disk spool and shared response cleanup used by audio uploads. */
export const videoUpload = multer({
    storage: audioDiskStorage,
    limits: {
        fileSize: maxVideoUploadMb * 1024 * 1024,
        files: 1,
        fields: 1,
        // Multer treats this as the inclusive maximum: one ID field plus one file.
        parts: 2,
        fieldNameSize: 100,
        fieldSize: 1024,
        headerPairs: 100
    }
});
