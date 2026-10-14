import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { ObjectId } from 'mongodb';
import { parseBuffer } from 'music-metadata';
import { getS3 } from '../infrastructure/s3';
import { formatDuration, inferAudioFormat, readAudioMetadata } from '../services/audioMetadataService';
import { prepareMediaRepresentation } from '../services/mediaRepresentationService';
import { validateCoverArtFile, maxCoverArtInputBytes } from '../services/imageStorageService';
import { maxAudioUploadMb } from '../middleware/audioUpload';
import { normalizeUtf8Text } from '../utils/textEncoding';
import { AdminImportError, exact, importEnabled, objectId, record, uuid, type AdminImportResponse, type ImportEmbeddedTags } from './adminImportContract';
import { getAdminImport, importCollection, importPurposeFilter, importDigest, mutateAdminImport, withImportAdmin } from './adminImportService';
import { importPrivateStorageReady, type ImportAsset } from './adminImportMediaTypes';
import { adminWorkerSignal } from './adminWorkerLifecycle';
import { extractImportArtwork } from './adminImportArtwork';

export type ImportObjectIdentity = { etag: string; versionId: string | null };
export interface ImportObjectTarget { bucket: string; key: string; sha256: string; byteLength: number; contentType: string; importId: string; slotId: string; operationId: string }
/** All keys/buckets/metadata originate in durable server intent; clients never supply object locations. */
export interface ImportObjectStorage {
    put(target: ImportObjectTarget, file: Express.Multer.File, signal?: AbortSignal): Promise<ImportObjectIdentity>;
    head(target: ImportObjectTarget, signal?: AbortSignal): Promise<ImportObjectIdentity | null>;
    copy(source: ImportObjectTarget & ImportObjectIdentity, target: ImportObjectTarget, signal?: AbortSignal): Promise<ImportObjectIdentity>;
    delete(target: ImportObjectTarget & ImportObjectIdentity): Promise<void>;
    read?(target: ImportObjectTarget & ImportObjectIdentity): Promise<Buffer>;
}
const identity = (etag: unknown, versionId: unknown): ImportObjectIdentity => {
    if (typeof etag !== 'string' || !/^"[^"\r\n]{1,200}"$/.test(etag) || (versionId !== undefined && versionId !== null && (typeof versionId !== 'string' || !versionId || versionId.length > 1024 || /[\r\n]/.test(versionId)))) throw new Error('Invalid storage identity');
    return { etag, versionId: typeof versionId === 'string' ? versionId : null };
};
const metadata = (target: ImportObjectTarget) => ({ importid: target.importId, slotid: target.slotId, operationid: target.operationId, sha256: target.sha256 });
export const defaultImportObjectStorage: ImportObjectStorage = {
    async put(target, file, signal) {
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 90_000), body = file.path ? createReadStream(file.path) : file.buffer;
        try { const result = await getS3().send(new PutObjectCommand({ Bucket: target.bucket, Key: target.key, Body: body, ContentLength: target.byteLength, ContentType: target.contentType, IfNoneMatch: '*', Metadata: metadata(target), ChecksumSHA256: Buffer.from(target.sha256, 'hex').toString('base64') }), { abortSignal: adminWorkerSignal(controller.signal, signal) }); return identity(result.ETag, result.VersionId); }
        finally { clearTimeout(timer); if ('destroy' in body) body.destroy(); }
    },
    async head(target, signal) {
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15_000);
        try {
            const result = await getS3().send(new HeadObjectCommand({ Bucket: target.bucket, Key: target.key }), { abortSignal: adminWorkerSignal(controller.signal, signal) });
            if (result.ContentLength !== target.byteLength || result.ContentType !== target.contentType || Object.entries(metadata(target)).some(([key, value]) => result.Metadata?.[key] !== value)) throw new Error('Storage binding mismatch');
            return identity(result.ETag, result.VersionId);
        } catch (error: any) { if (error?.$metadata?.httpStatusCode === 404 || ['NotFound', 'NoSuchKey'].includes(error?.name)) return null; throw error; }
        finally { clearTimeout(timer); }
    },
    async copy(source, target, signal) {
        // One attempt prevents a delayed SDK retry from recreating a cancelled/deleted key. The 90s transfer
        // deadline and 15s reconciliation HEAD stay below the worker's freshly renewed 300s lease.
        // CopyObject has no equivalent destination condition in the supported SDK contract.
        const shared = getS3().config;
        const destination = new S3Client({ region: shared.region, credentials: shared.credentials, endpoint: shared.endpoint,
            forcePathStyle: shared.forcePathStyle, useArnRegion: shared.useArnRegion, maxAttempts: 1,
            requestHandler: { connectionTimeout: 5_000, requestTimeout: 60_000 } });
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 90_000); let body: any;
        try {
            const sourceObject = await getS3().send(new GetObjectCommand({ Bucket: source.bucket, Key: source.key, VersionId: source.versionId ?? undefined, IfMatch: source.etag }), { abortSignal: adminWorkerSignal(controller.signal, signal) }); body = sourceObject.Body;
            if (!body || sourceObject.ContentLength !== source.byteLength) throw new Error('Invalid source');
            const result = await destination.send(new PutObjectCommand({ Bucket: target.bucket, Key: target.key, Body: body, IfNoneMatch: '*', ContentLength: target.byteLength, ContentType: target.contentType, Metadata: metadata(target), ChecksumSHA256: Buffer.from(target.sha256, 'hex').toString('base64') }), { abortSignal: adminWorkerSignal(controller.signal, signal) });
            return identity(result.ETag, result.VersionId);
        } finally { clearTimeout(timer); body?.destroy?.(); destination.destroy(); }
    },
    async delete(target) { const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30_000); try { await getS3().send(new DeleteObjectCommand({ Bucket: target.bucket, Key: target.key, VersionId: target.versionId ?? undefined, IfMatch: target.etag }), { abortSignal: controller.signal }); } finally { clearTimeout(timer); } },
    async read(target) {
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15_000); let body: any;
        try {
            const result = await getS3().send(new GetObjectCommand({ Bucket: target.bucket, Key: target.key, VersionId: target.versionId ?? undefined, IfMatch: target.etag }), { abortSignal: controller.signal }); body = result.Body;
            if (!body || result.ContentLength !== target.byteLength || target.byteLength > maxCoverArtInputBytes || result.ContentType !== target.contentType) throw new Error('Invalid artwork');
            const parts: Buffer[] = []; let length = 0;
            for await (const chunk of body) { length += chunk.length; if (length > target.byteLength) throw new Error('Invalid artwork'); parts.push(Buffer.from(chunk)); }
            const bytes = Buffer.concat(parts); if (length !== target.byteLength || createHash('sha256').update(bytes).digest('hex') !== target.sha256) throw new Error('Invalid artwork'); return bytes;
        } finally { clearTimeout(timer); body?.destroy?.(); }
    }
};
export const importAssetTarget = (importId: string, asset: ImportAsset): ImportObjectTarget => ({ bucket: asset.bucket, key: asset.key, sha256: asset.sha256, byteLength: asset.byteLength, contentType: asset.contentType, importId, slotId: asset.slotId, operationId: asset.operationId });
export function importMediaMutationHeaders(operationId: unknown, revision: unknown) {
    if (!uuid(operationId) || typeof revision !== 'string' || !/^[1-9]\d{0,10}$/.test(revision) || !Number.isSafeInteger(Number(revision))) throw new AdminImportError(400, 'ADMIN_IMPORT_INVALID_INPUT');
    return { operationId, expectedRevision: Number(revision) };
}
const storageReady = () => { if (!importEnabled() || !importPrivateStorageReady()) throw new AdminImportError(503, 'ADMIN_IMPORT_STORAGE_UNAVAILABLE'); };
async function fileDigest(file: Express.Multer.File) {
    const hash = createHash('sha256'); let bytes = 0;
    if (file.path) for await (const chunk of createReadStream(file.path)) { bytes += chunk.length; hash.update(chunk); }
    else { bytes = file.buffer?.length ?? 0; hash.update(file.buffer); }
    if (bytes !== file.size) throw new AdminImportError(400, 'ADMIN_IMPORT_FILE_CHANGED'); return hash.digest('hex');
}

/** Reserves the only object identity before PUT; retry reconciles the same binding instead of replacing bytes. */
export async function uploadAdminImportAsset(actor: string, id: string, slotId: string, intent: { operationId: string; expectedRevision: number }, file: Express.Multer.File, storage: ImportObjectStorage = defaultImportObjectStorage, embeddedSource?: string): Promise<AdminImportResponse> {
    storageReady();
    const imageSlot = slotId === 'cover' || (uuid(embeddedSource) && slotId === `embedded-${embeddedSource}`);
    if (!objectId(id) || (!imageSlot && !uuid(slotId)) || !file || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > (imageSlot ? maxCoverArtInputBytes : maxAudioUploadMb * 1024 ** 2)) throw new AdminImportError(400, 'ADMIN_IMPORT_INVALID_FILE');
    const current = await getAdminImport(actor, id); const manifest = current.item.manifest.files.find(file => file.slotId === slotId);
    if (!imageSlot && (!manifest || normalizeUtf8Text(file.originalname) !== manifest.filename || (manifest.byteLength !== null && manifest.byteLength !== file.size))) throw new AdminImportError(400, 'ADMIN_IMPORT_FILE_CHANGED');
    if (embeddedSource && !current.item.assets.some(asset => asset.slotId === embeddedSource && asset.state === 'ready')) throw new AdminImportError(409, 'ADMIN_IMPORT_ASSET_CONFLICT');
    let duration: string | null = null, format: string | null = null, representation: ImportAsset['representation'] = null;
    let tags: ImportEmbeddedTags | null = null;
    if (imageSlot) { try { await validateCoverArtFile(file); } catch { throw new AdminImportError(400, 'ADMIN_IMPORT_INVALID_COVER'); } }
    else {
        if (!/^audio\/[a-zA-Z0-9.+-]+$/.test(file.mimetype)) throw new AdminImportError(400, 'ADMIN_IMPORT_INVALID_AUDIO');
        try {
            const metadata = file.path ? await readAudioMetadata(file) : await parseBuffer(Uint8Array.from(file.buffer), { mimeType: file.mimetype, path: file.originalname, size: file.size }, { duration: true, skipCovers: true }); const audio = metadata.format;
            if (!Number.isFinite(audio.duration) || audio.duration! <= 0 || audio.duration! > 86400 || !audio.sampleRate || !audio.numberOfChannels || audio.hasVideo === true || audio.trackInfo?.some(track => track.type === 1)) throw new Error();
            duration = formatDuration(audio.duration); format = inferAudioFormat(file.originalname, file.mimetype, audio.container);
            const safeTag = (value: unknown) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, 200) || null : null;
            tags = { title: safeTag(metadata.common.title), album: safeTag(metadata.common.album), artists: (metadata.common.artists ?? (metadata.common.artist ? [metadata.common.artist] : [])).slice(0, 10).map(safeTag).filter((value): value is string => Boolean(value)), year: Number.isInteger(metadata.common.year) && metadata.common.year! > 0 && metadata.common.year! <= 9999 ? metadata.common.year! : null, trackNumber: Number.isInteger(metadata.common.track?.no) && metadata.common.track.no! > 0 && metadata.common.track.no! <= 9999 ? metadata.common.track.no : null };
            representation = await prepareMediaRepresentation(file, `imports/${id}/${slotId}/${intent.operationId}`, 'audio');
        } catch { throw new AdminImportError(400, 'ADMIN_IMPORT_INVALID_AUDIO'); }
    }
    const sha256 = await fileDigest(file), worker = randomUUID();
    const admitted = await mutateAdminImport(actor, id, { ...intent, slotId, sha256, byteLength: file.size, contentType: file.mimetype }, 'upload', async doc => {
        doc.media ??= { assets: [] };
        const previous = doc.media.assets.find(asset => asset.slotId === slotId);
        if (previous && previous.state !== 'deleted') throw new AdminImportError(409, 'ADMIN_IMPORT_ASSET_EXISTS');
        if (previous) { doc.media.assetHistory ??= []; doc.media.assetHistory.push(previous); doc.media.assets = doc.media.assets.filter(asset => asset !== previous); }
        doc.media.assets.push({ slotId, operationId: intent.operationId, actorId: actor, bucket: process.env.ADMIN_IMPORT_S3_BUCKET_NAME!.trim(), key: `imports/${id}/${slotId}/${intent.operationId}`, sha256, byteLength: file.size, contentType: file.mimetype, filename: normalizeUtf8Text(file.originalname), state: 'pending', versionId: null, etag: null, updatedAt: new Date(), leaseOwner: null, leaseUntil: null, duration, format, representation, tags, recovery: { ...intent, kind: 'upload', actorId: actor } });
    });
    const asset = await withImportAdmin(actor, async session => {
        const doc = await importCollection().findOne({ ...importPurposeFilter, _id: new ObjectId(id) }, { session }); const asset = doc?.media?.assets.find(a => a.slotId === slotId && a.operationId === intent.operationId);
        if (!doc || !asset || asset.sha256 !== sha256) throw new AdminImportError(409, 'ADMIN_IMPORT_ASSET_CONFLICT');
        if (asset.state === 'ready') return null;
        if (['deleted', 'deleting', 'cleanupFailed'].includes(asset.state) || (doc.media?.publication && (doc.media.publication.state !== 'cancelled' || doc.media.publication.cleanupPending))) throw new AdminImportError(409, 'ADMIN_IMPORT_ASSET_CONFLICT');
        if (asset.leaseUntil && asset.leaseUntil > new Date()) throw new AdminImportError(409, 'ADMIN_IMPORT_ASSET_BUSY');
        asset.leaseOwner = worker; asset.leaseUntil = new Date(Date.now() + 300_000); asset.state = 'pending';
        await importCollection().replaceOne({ _id: doc._id, revision: doc.revision }, doc, { session }); return asset;
    });
    let confirmed: ImportObjectIdentity | null = null, state: ImportAsset['state'] = asset ? 'unknown' : 'ready';
    if (asset) { try {
        confirmed = await storage.head(importAssetTarget(id, asset));
        if (!confirmed) { try { confirmed = await storage.put(importAssetTarget(id, asset), file); } catch { confirmed = await storage.head(importAssetTarget(id, asset)); } }
        state = confirmed ? 'ready' : 'failed';
    } catch { state = 'unknown'; }
    // Lifecycle evidence must be retained even if the initiating admin lost access during upload.
    await importCollection().updateOne({ _id: new ObjectId(id), 'media.assets': { $elemMatch: { slotId, operationId: intent.operationId, leaseOwner: worker } } }, { $set: { 'media.assets.$.state': state, 'media.assets.$.etag': confirmed?.etag ?? null, 'media.assets.$.versionId': confirmed?.versionId ?? null, 'media.assets.$.leaseOwner': null, 'media.assets.$.leaseUntil': null, 'media.assets.$.updatedAt': new Date(), updatedAt: new Date() }, $inc: { revision: 1 } }); }
    if (state === 'ready' && !imageSlot) {
        const artwork = await extractImportArtwork(file);
        if (artwork) {
            const hash = importDigest({ operationId: intent.operationId, embedded: slotId }); const operationId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
            try { const latest = await getAdminImport(actor, id); await uploadAdminImportAsset(actor, id, `embedded-${slotId}`, { operationId, expectedRevision: latest.item.revision }, artwork, storage, slotId); } catch { /* Audio success is independent; any admitted candidate retains its own lifecycle evidence. */ }
        }
    }
    return { ...(await getAdminImport(actor, id)), receipt: admitted.receipt };
}

/** Explicit stage cleanup preserves the record until the exact inventoried object version is removed. */
export async function cleanupAdminImportAsset(actor: string, id: string, slotId: string, intent: { operationId: string; expectedRevision: number }, storage: ImportObjectStorage = defaultImportObjectStorage) {
    const admitted = await mutateAdminImport(actor, id, { ...intent, slotId }, 'cleanup', async doc => {
        const asset = doc.media?.assets.find(asset => asset.slotId === slotId); if (!asset) throw new AdminImportError(404, 'ADMIN_IMPORT_ASSET_NOT_FOUND');
        if (asset.coverConsumers?.length) throw new AdminImportError(409, 'ADMIN_IMPORT_ASSET_IN_USE');
        if (doc.media?.publication && doc.media.publication.state !== 'complete' && !(doc.media.publication.state === 'cancelled' && !doc.media.publication.cleanupPending)) throw new AdminImportError(409, 'ADMIN_IMPORT_PUBLICATION_LOCKED');
        if (asset.recovery?.kind === 'cleanup') throw new AdminImportError(409, 'ADMIN_IMPORT_ASSET_CLEANUP_EXISTS');
        if (asset.leaseUntil && asset.leaseUntil > new Date()) throw new AdminImportError(409, 'ADMIN_IMPORT_ASSET_BUSY');
        if (asset.state !== 'deleted') asset.state = 'deleting';
        asset.recovery = { ...intent, kind: 'cleanup', actorId: actor };
        if (doc.media?.selectedCoverSlotId === slotId) doc.media.selectedCoverSlotId = null;
    });
    const doc = await importCollection().findOne({ ...importPurposeFilter, _id: new ObjectId(id) }); const asset = doc?.media?.assets.find(asset => asset.slotId === slotId && asset.recovery?.operationId === intent.operationId);
    if (!asset) { if (doc?.media?.assetHistory?.some(asset => asset.slotId === slotId && asset.recovery?.operationId === intent.operationId && asset.state === 'deleted')) return { ...(await getAdminImport(actor, id)), receipt: admitted.receipt }; throw new AdminImportError(409, 'ADMIN_IMPORT_ASSET_CONFLICT'); }
    if (asset.state === 'deleted') return admitted;
    let state: ImportAsset['state'] = 'cleanupFailed';
    const authorize = () => withImportAdmin(actor, async session => {
        const current = await importCollection().findOne({ ...importPurposeFilter, _id: new ObjectId(id), 'media.assets': { $elemMatch: {
            slotId, operationId: asset.operationId, 'recovery.operationId': intent.operationId, state: { $in: ['deleting', 'cleanupFailed'] }
        } } }, { session });
        if (!current) throw new AdminImportError(409, 'ADMIN_IMPORT_ASSET_CONFLICT');
    });
    try {
        const target = importAssetTarget(id, asset); await authorize();
        const stored = asset.etag ? { etag: asset.etag, versionId: asset.versionId } : await storage.head(target);
        if (stored) { await authorize(); await storage.delete({ ...target, ...stored }); }
        await authorize(); if (await storage.head(target)) throw new Error(); state = 'deleted';
    } catch { /* Retain failed/unknown cleanup evidence for the same-key retry. */ }
    await importCollection().updateOne({ _id: new ObjectId(id), 'media.assets': { $elemMatch: { slotId, operationId: asset.operationId, 'recovery.operationId': intent.operationId, state: { $in: ['deleting', 'cleanupFailed'] } } } }, { $set: { 'media.assets.$.state': state, 'media.assets.$.updatedAt': new Date(), updatedAt: new Date() }, $inc: { revision: 1 } });
    return { ...(await getAdminImport(actor, id)), receipt: admitted.receipt };
}

/** Selecting artwork is an explicit draft mutation; extracted candidates never select themselves. */
export function selectAdminImportCover(actor: string, id: string, raw: unknown) {
    const body = record(raw); exact(body, ['operationId', 'expectedRevision', 'slotId']);
    if (!uuid(body.operationId) || !Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 1 || (body.slotId !== null && typeof body.slotId !== 'string')) throw new AdminImportError(400, 'ADMIN_IMPORT_INVALID_INPUT');
    return mutateAdminImport(actor, id, body as typeof body & { operationId: string; expectedRevision: number }, 'select-cover', async doc => {
        if (body.slotId !== null && !doc.media?.assets.some(asset => asset.slotId === body.slotId && asset.contentType.startsWith('image/') && asset.state === 'ready')) throw new AdminImportError(409, 'ADMIN_IMPORT_ASSET_CONFLICT');
        doc.media ??= { assets: [] }; doc.media.selectedCoverSlotId = body.slotId as string | null;
    });
}

/** Private image bytes stay behind fresh admin and exact asset-version checks; no signed S3 URL escapes. */
export async function previewAdminImportAsset(actor: string, id: string, slotId: string, storage: ImportObjectStorage = defaultImportObjectStorage) {
    const capture = () => withImportAdmin(actor, async session => {
        if (!objectId(id)) throw new AdminImportError(404, 'ADMIN_IMPORT_ASSET_NOT_FOUND');
        const doc = await importCollection().findOne({ ...importPurposeFilter, _id: new ObjectId(id) }, { session });
        const asset = doc?.media?.assets.find(asset => asset.slotId === slotId && asset.state === 'ready' && ['image/jpeg', 'image/png', 'image/webp'].includes(asset.contentType));
        if (!asset?.etag || asset.byteLength > maxCoverArtInputBytes) throw new AdminImportError(404, 'ADMIN_IMPORT_ASSET_NOT_FOUND'); return asset;
    });
    const asset = await capture(); if (!storage.read) throw new AdminImportError(503, 'ADMIN_IMPORT_STORAGE_UNAVAILABLE');
    let bytes: Buffer; try { bytes = await storage.read({ ...importAssetTarget(id, asset), etag: asset.etag!, versionId: asset.versionId }); } catch { throw new AdminImportError(503, 'ADMIN_IMPORT_STORAGE_UNAVAILABLE'); }
    const current = await capture(); if (current.operationId !== asset.operationId || current.etag !== asset.etag || current.versionId !== asset.versionId || bytes.length !== asset.byteLength || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new AdminImportError(409, 'ADMIN_IMPORT_ASSET_CONFLICT');
    return { bytes, contentType: asset.contentType };
}
