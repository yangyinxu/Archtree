import 'dotenv/config';
import multer from 'multer';

const configuredMaxAudioUploadMb = Number(process.env.MAX_AUDIO_UPLOAD_MB ?? 512);
export const maxAudioUploadMb = Number.isFinite(configuredMaxAudioUploadMb) && configuredMaxAudioUploadMb > 0
    ? configuredMaxAudioUploadMb
    : 512;

export const audioUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: maxAudioUploadMb * 1024 * 1024,
        files: 20
    }
});
