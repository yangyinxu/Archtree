import multer from 'multer';
import { maxAudioUploadMb } from './audioUpload';

const configuredMaxImageUploadMb = Number(process.env.MAX_IMAGE_UPLOAD_MB ?? 10);
export const maxImageUploadMb = Number.isFinite(configuredMaxImageUploadMb) && configuredMaxImageUploadMb > 0
    ? configuredMaxImageUploadMb
    : 10;

const storage = multer.memoryStorage();

export const imageUpload = multer({
    storage,
    limits: {
        fileSize: maxImageUploadMb * 1024 * 1024,
        files: 1
    }
});

// Multer only supports one per-file size limit. Audio creation accepts both an
// audio file and cover art, so the image service enforces the smaller image limit.
export const audioWithCoverArtUpload = multer({
    storage,
    limits: {
        fileSize: maxAudioUploadMb * 1024 * 1024,
        files: 2
    }
}).fields([
    { name: 'audioFile', maxCount: 1 },
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
