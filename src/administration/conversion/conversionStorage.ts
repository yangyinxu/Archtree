import { DeleteObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { createReadStream } from 'node:fs';
import { getS3 } from '../../infrastructure/s3';
import { conversionEtag } from './conversionContract';

/** Internal object locations never enter the conversion response DTO. */
export interface ConversionStorageTarget { bucket: string; key: string }
export interface ConversionStorageIdentity {
    etag: string; versionId: string | null; byteLength: number; contentType: string | null;
    sha256: string | null; operationId: string | null; trackId: string | null;
}
export interface ConversionObjectStorage {
    head(target: ConversionStorageTarget, versionId?: string | null): Promise<ConversionStorageIdentity | null>;
    put(target: ConversionStorageTarget, file: Express.Multer.File, metadata: { sha256: string; operationId: string; trackId: string }, signal?: AbortSignal): Promise<ConversionStorageIdentity>;
    delete(target: ConversionStorageTarget, identity: ConversionStorageIdentity): Promise<void>;
}
const timed = async <T>(milliseconds: number, work: (signal: AbortSignal) => Promise<T>, upstream?: AbortSignal) => {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), milliseconds);
    const signal = upstream ? AbortSignal.any([upstream, controller.signal]) : controller.signal;
    try { signal.throwIfAborted(); return await work(signal); } finally { clearTimeout(timer); }
};
function storageIdentity(value: any): ConversionStorageIdentity {
    if (!conversionEtag(value.ETag) || !Number.isSafeInteger(value.ContentLength) || value.ContentLength <= 0
        || (value.VersionId !== undefined && (typeof value.VersionId !== 'string' || !value.VersionId || value.VersionId.length > 1024 || /[\r\n]/.test(value.VersionId)))) throw new Error('Invalid conversion storage identity');
    return { etag: value.ETag, versionId: value.VersionId ?? null, byteLength: value.ContentLength,
        contentType: typeof value.ContentType === 'string' ? value.ContentType : null,
        sha256: typeof value.Metadata?.sha256 === 'string' ? value.Metadata.sha256 : null,
        operationId: typeof value.Metadata?.operationid === 'string' ? value.Metadata.operationid : null,
        trackId: typeof value.Metadata?.trackid === 'string' ? value.Metadata.trackid : null };
}

/** Conditional writes and exact-version deletes keep one approved output safe across unknown acknowledgements. */
export const defaultConversionStorage: ConversionObjectStorage = {
    async head(target, versionId) {
        try { return await timed(15_000, async signal => storageIdentity(await getS3().send(new HeadObjectCommand({
            Bucket: target.bucket, Key: target.key, ...(versionId ? { VersionId: versionId } : {})
        }), { abortSignal: signal }))); }
        catch (error: any) { if (error?.$metadata?.httpStatusCode === 404 || ['NotFound', 'NoSuchKey', 'NoSuchVersion'].includes(error?.name)) return null; throw error; }
    },
    async put(target, file, metadata, signal) {
        await timed(90_000, async boundedSignal => {
            const body = file.path ? createReadStream(file.path) : file.buffer;
            try { await getS3().send(new PutObjectCommand({ Bucket: target.bucket, Key: target.key,
                Body: body, ContentLength: file.size, ContentType: 'audio/mpeg', IfNoneMatch: '*',
                ChecksumSHA256: Buffer.from(metadata.sha256, 'hex').toString('base64'),
                Metadata: { sha256: metadata.sha256, operationid: metadata.operationId, trackid: metadata.trackId }
            }), { abortSignal: boundedSignal }); }
            finally { if (file.path) (body as ReturnType<typeof createReadStream>).destroy(); }
        }, signal);
        const stored = await this.head(target);
        if (!stored) throw new Error('Unconfirmed conversion upload');
        return stored;
    },
    async delete(target, identity) {
        await timed(30_000, signal => getS3().send(new DeleteObjectCommand({ Bucket: target.bucket, Key: target.key,
            IfMatch: identity.etag, ...(identity.versionId ? { VersionId: identity.versionId } : {})
        }), { abortSignal: signal }));
    }
};
