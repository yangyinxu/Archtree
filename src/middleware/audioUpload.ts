import 'dotenv/config';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextFunction, Request, Response } from 'express';

const configuredMaxAudioUploadMb = Number(process.env.MAX_AUDIO_UPLOAD_MB ?? 512);
export const maxAudioUploadMb = Number.isFinite(configuredMaxAudioUploadMb) && configuredMaxAudioUploadMb > 0
    ? configuredMaxAudioUploadMb
    : 512;

const configuredMaxBatchUploadMb = Number(process.env.MAX_AUDIO_BATCH_UPLOAD_MB ?? 1024);
export const maxAudioBatchUploadMb = Number.isFinite(configuredMaxBatchUploadMb) && configuredMaxBatchUploadMb > 0
    ? configuredMaxBatchUploadMb
    : 1024;
const configuredMaxBatchFiles = Number(process.env.MAX_AUDIO_BATCH_FILES ?? 5);
export const maxAudioBatchFiles = Number.isFinite(configuredMaxBatchFiles) && configuredMaxBatchFiles > 0
    ? Math.min(20, Math.floor(configuredMaxBatchFiles))
    : 5;
const temporaryPaths = new WeakMap<Request, string[]>();

export const audioDiskStorage = multer.diskStorage({
    destination: os.tmpdir(),
    filename: (req, file, callback) => {
        const extension = path.extname(file.originalname).slice(0, 16);
        const fileName = `archtree-upload-${randomUUID()}${extension}`;
        const paths = temporaryPaths.get(req) ?? [];
        paths.push(path.join(os.tmpdir(), fileName));
        temporaryPaths.set(req, paths);
        callback(null, fileName);
    }
});

export const audioUpload = multer({
    storage: audioDiskStorage,
    limits: {
        fileSize: maxAudioUploadMb * 1024 * 1024,
        files: maxAudioBatchFiles
    }
});

export const requireUploadSize = (maximumMb: number) => (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    const contentLength = Number(req.get('Content-Length'));
    if (!Number.isSafeInteger(contentLength) || contentLength <= 0) {
        return res.status(411).json({ message: 'A valid Content-Length header is required for uploads.' });
    }
    if (contentLength > maximumMb * 1024 * 1024) {
        return res.status(413).json({ message: `Upload request exceeds the ${maximumMb} MB limit.` });
    }
    return next();
};

const uploadedFiles = (req: Request) => {
    if (req.file) return [req.file];
    if (Array.isArray(req.files)) return req.files;
    if (req.files) return Object.values(req.files).flat();
    return [];
};

export const cleanupTemporaryUploads = (req: Request, res: Response, next: NextFunction) => {
    let cleaned = false;
    const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        const paths = new Set([
            ...(temporaryPaths.get(req) ?? []),
            ...uploadedFiles(req)
                .map((file) => file.path)
                .filter((filePath): filePath is string => Boolean(filePath))
        ]);
        temporaryPaths.delete(req);
        void Promise.all([...paths].map((filePath) => fs.unlink(filePath).catch(() => undefined)));
    };
    res.once('finish', cleanup);
    res.once('close', cleanup);
    return next();
};
