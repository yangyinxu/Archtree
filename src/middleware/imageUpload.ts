import multer from 'multer';
import { audioDiskStorage, maxAudioUploadMb } from './audioUpload';

const configuredMaxImageUploadMb = Number(process.env.MAX_IMAGE_UPLOAD_MB ?? 10);
export const absoluteMaxImageUploadMb = 25;
export const maxImageUploadMb = Number.isFinite(configuredMaxImageUploadMb) && configuredMaxImageUploadMb > 0
    ? Math.min(configuredMaxImageUploadMb, absoluteMaxImageUploadMb)
    : 10;
export const maxAvatarUploadMb = 5;
/** Allows the image ceiling plus bounded multipart headers, before memory parsing. */
export const maxAvatarRequestMb = 6;

const storage = multer.memoryStorage();

export const imageUpload = multer({
    storage,
    limits: {
        fileSize: maxImageUploadMb * 1024 * 1024,
        files: 1
    }
});

/** Accepts the two independently bounded cover-art fields in Artist release setup. */
export const artistReleaseImageUpload = multer({
    storage,
    limits: {
        fileSize: maxImageUploadMb * 1024 * 1024,
        files: 2
    }
}).fields([
    { name: 'artistCoverArtFile', maxCount: 1 },
    { name: 'albumCoverArtFile', maxCount: 1 }
]);

export const avatarUpload = multer({
    storage,
    limits: {
        // Busboy emits the limit event when the size reaches the ceiling.
        fileSize: maxAvatarUploadMb * 1024 * 1024 + 1,
        files: 1,
        fields: 0,
        // Busboy's parts ceiling is exclusive of the one accepted file part.
        parts: 2,
        fieldNameSize: 100,
        fieldSize: 1024,
        headerPairs: 100
    }
});

// Multer only supports one per-file size limit. Audio creation accepts both an
// audio file and cover art, so the image service enforces the smaller image limit.
export const audioWithCoverArtUpload = multer({
    storage: audioDiskStorage,
    limits: {
        fileSize: maxAudioUploadMb * 1024 * 1024,
        files: 2
    }
}).fields([
    { name: 'audioFile', maxCount: 1 },
    { name: 'coverArtFile', maxCount: 1 }
]);

/** Accepts one Audio or Video MediaTrack plus optional cover art for manager creation. */
export const mediaWithCoverArtUpload = (maximumMediaUploadMb: number) => multer({
    storage: audioDiskStorage,
    limits: {
        fileSize: maximumMediaUploadMb * 1024 * 1024,
        files: 2
    }
}).fields([
    { name: 'mediaFile', maxCount: 1 },
    { name: 'coverArtFile', maxCount: 1 }
]);

export const getUploadedFile = (req: Express.Request, fieldName: string) => {
    if (req.file?.fieldname === fieldName) {
        return req.file;
    }

    const files = req.files;
    if (files && !Array.isArray(files)) {
        return files[fieldName]?.[0];
    }

    return undefined;
};
