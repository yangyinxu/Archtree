import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import type { RequestHandler } from 'express';
import { ObjectId } from 'mongodb';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { getDb } from '../infrastructure/database';
import { getS3 } from '../infrastructure/s3';
import type { AuthenticatedRequest } from '../middleware/authMiddleware';
import { createMediaAbortContext, pipeMediaStream, shouldHonorRange } from '../services/mediaDeliveryService';
import { resolveMediaTrackByteResponse } from '../controllers/mediaTrackController';
import { activeMediaObjectKeyForTrack, activeMediaContentTypeForTrack } from '../utils/mediaStorageKey';
import { isCoverArtObjectKeyForImage } from '../services/imageStorageService';
import { adminCatalogKind, readAdminCatalogRecord, type AdminCatalogKind } from './adminCatalogService';
import { adminCatalogArtworkSource } from './adminCatalogArtworkSource';
import { legacyCatalogArtwork } from './adminLegacyArtwork';

const currentAdmin = async (actor: string, sessionId?: string) => {
    if (!await getDb()!.collection('users').findOne({ _id: new ObjectId(actor), role: 'admin' }, { projection: { _id: 1 }, maxTimeMS: 400 })) return false;
    return !sessionId || Boolean(await getDb()!.collection('authSessions').findOne({
        _id: new ObjectId(sessionId), userId: actor, revokedAt: { $exists: false }, expiresAt: { $gt: new Date() }
    }, { projection: { _id: 1 }, maxTimeMS: 400 }));
};
type PreviewAsset = { key: string; type: string; imageId: string | null; reference?: string }
    | { url: string; reference: string; type: 'image/webp'; imageId: null };

/** Preview sources stay inside server storage; never redirect to a public or signed external URL. */
const assetFor = async (kind: AdminCatalogKind, id: string, artwork: boolean): Promise<PreviewAsset | null> => {
    const doc = await readAdminCatalogRecord(kind, id);
    if (!doc) return null;
    if (!artwork) {
        const key = activeMediaObjectKeyForTrack(doc);
        return key ? { key, type: activeMediaContentTypeForTrack(doc), imageId: null } : null;
    }
    const source = adminCatalogArtworkSource(doc);
    if (!source) return null;
    if (source.kind === 'external') return { url: source.url, reference: source.reference, type: 'image/webp', imageId: null };
    const imageId = source.imageId;
    const image = await getDb()!.collection('imageAssets').findOne({ _id: new ObjectId(imageId),
        ownerId: id, ownerType: kind, uploadStatus: 'ready' }, { maxTimeMS: 400 });
    if (!image || !isCoverArtObjectKeyForImage(image.s3Key, imageId)
        || !['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(String(image.contentType))) return null;
    return { key: image.s3Key, type: image.contentType, imageId, reference: source.reference };
};

/** Hidden previews verify the current role and exact source throughout a live response. */
const preview = (artwork: boolean): RequestHandler => async (req, res) => {
    const context = createMediaAbortContext(req, res);
    res.setHeader('Cache-Control', 'private, no-store, no-transform');
    try {
        const { userId: actor, sessionId } = (req as AuthenticatedRequest).auth!;
        const kind = artwork ? adminCatalogKind(req.params.kind) : 'audioTrack';
        const id = req.params.id;
        if (!/^[0-9a-f]{24}$/.test(id) || !await currentAdmin(actor, sessionId)) return res.status(404).end();
        const asset = await assetFor(kind, id, artwork);
        if (!asset) return res.status(404).end();
        if ('url' in asset) {
            const authorize = async () => {
                if (!await currentAdmin(actor, sessionId)) return false;
                const current = await assetFor(kind, id, true);
                return Boolean(current && 'url' in current && current.url === asset.url && current.reference === asset.reference);
            };
            const body = await legacyCatalogArtwork.load(asset.url, context.signal, { clientKey: actor });
            const etag = `"${createHash('sha256').update(body).digest('base64url')}"`;
            if (!await authorize()) return res.status(404).end();
            if (req.headers['if-match'] !== undefined && req.headers['if-match'] !== etag) return res.status(412).end();
            const requestedRange = shouldHonorRange(typeof req.headers['if-range'] === 'string' ? req.headers['if-range'] : undefined, etag) ? req.headers.range : undefined;
            const range = resolveMediaTrackByteResponse(requestedRange, body.length);
            if (range.status === 416) { res.setHeader('Content-Range', range.contentRange); return res.status(416).end(); }
            const headers = () => {
                res.setHeader('Content-Type', asset.type); res.setHeader('X-Content-Type-Options', 'nosniff');
                res.setHeader('Content-Length', req.method === 'HEAD' ? body.length : range.end - range.start + 1);
                res.setHeader('ETag', etag); res.setHeader('Accept-Ranges', 'bytes');
                if (req.method !== 'HEAD' && range.status === 206) res.setHeader('Content-Range', range.contentRange);
            };
            if (req.method === 'HEAD') { headers(); return res.status(200).end(); }
            await pipeMediaStream(req, res, Readable.from([body.subarray(range.start, range.end + 1)]), context,
                { authorize, onAuthorized: () => { res.status(range.status); headers(); } });
            return;
        }
        const params = { Bucket: process.env.S3_BUCKET_NAME!, Key: asset.key };
        const head = await getS3().send(new HeadObjectCommand(params), { abortSignal: context.signal });
        if (!Number.isSafeInteger(head.ContentLength) || head.ContentLength! <= 0
            || typeof head.ETag !== 'string' || !/^"[^"\r\n]{1,200}"$/.test(head.ETag)) return res.status(404).end();
        // Native preview chunks bind the same strong identity as their initial HEAD.
        if (req.headers['if-match'] !== undefined && req.headers['if-match'] !== head.ETag) return res.status(412).end();
        const requestedRange = shouldHonorRange(typeof req.headers['if-range'] === 'string' ? req.headers['if-range'] : undefined, head.ETag) ? req.headers.range : undefined;
        const range = resolveMediaTrackByteResponse(requestedRange, head.ContentLength!);
        const authorize = async () => {
            if (!await currentAdmin(actor, sessionId)) return false;
            const current = await assetFor(kind, id, artwork);
            return Boolean(current && 'key' in current && current.key === asset.key && current.imageId === asset.imageId
                && current.reference === asset.reference);
        };
        if (range.status === 416) {
            if (!await authorize()) return res.status(404).end();
            res.setHeader('Content-Range', range.contentRange); return res.status(416).end();
        }
        if (req.method === 'HEAD') {
            if (!await authorize()) return res.status(404).end();
            res.setHeader('Content-Type', asset.type); res.setHeader('Content-Length', head.ContentLength!);
            res.setHeader('ETag', head.ETag); res.setHeader('Accept-Ranges', 'bytes'); return res.status(200).end();
        }
        const object = await getS3().send(new GetObjectCommand({ ...params, IfMatch: head.ETag,
            ...(head.VersionId ? { VersionId: head.VersionId } : {}), Range: range.status === 206 ? `bytes=${range.start}-${range.end}` : undefined }), { abortSignal: context.signal });
        const stream = object.Body as Readable | undefined;
        if (!stream || typeof stream.pipe !== 'function') return res.status(502).end();
        await pipeMediaStream(req, res, stream, context, { authorize, onAuthorized: () => {
            res.status(range.status);
            res.setHeader('Content-Type', asset.type); res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('Accept-Ranges', 'bytes'); res.setHeader('X-Accel-Buffering', 'no');
            res.setHeader('Content-Length', range.end - range.start + 1);
            res.setHeader('ETag', head.ETag!);
            if (range.status === 206) res.setHeader('Content-Range', range.contentRange);
        } });
    } catch {
        if (context.aborted) return;
        if (res.headersSent) res.destroy(); else res.status(404).end();
    } finally { context.cleanup(); }
};
export const adminCatalogArtwork = preview(true);
export const adminCatalogMedia = preview(false);
