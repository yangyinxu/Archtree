import multer from 'multer';

const maxAudioUploadMb = Math.max(1, Number(process.env.MAX_AUDIO_UPLOAD_MB ?? 200));

export const audioUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxAudioUploadMb * 1024 * 1024 }
});
