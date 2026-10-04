import { NextFunction, Request, Response } from 'express';
import { Readable } from 'node:stream';
import { AuthenticatedRequest } from '../middleware/authMiddleware';
import { getUploadedFile } from '../middleware/imageUpload';
import User from '../models/user';
import { executeAvatarMutation } from '../services/avatarOperationService';
import { getAvatarObject } from '../services/avatarStorageService';
import { createMediaAbortContext, pipeMediaStream } from '../services/mediaDeliveryService';

const revisionOf = (user: Record<string, any> | null) => Number(user?.avatarRevision ?? 0);

const mutationHeaders = (req: Request) => {
    const idempotencyKey = String(req.get('Idempotency-Key') ?? '').trim();
    const rawRevision = String(req.get('If-Match') ?? '').replace(/"/g, '').trim();
    const expectedRevision = Number(rawRevision);
    if (!idempotencyKey || idempotencyKey.length > 200) {
        throw Object.assign(new Error('A valid Idempotency-Key header is required.'), { statusCode: 400 });
    }
    if (!rawRevision || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        throw Object.assign(new Error('A valid avatar revision is required in If-Match.'), { statusCode: 428 });
    }
    return { idempotencyKey, expectedRevision };
};

const sendMutationResult = (res: Response, result: { statusCode: number; body?: Record<string, unknown> }) => {
    if (result.body) return res.status(result.statusCode).json(result.body);
    return res.status(result.statusCode).send();
};

/** Binds optional Web avatar reads to the session projection that requested them. */
export const assertAvatarReadIdentity = (
    req: Request,
    authenticatedUserId: string,
    user: Record<string, any> | null
) => {
    const requestedViewer = String(req.get('X-Finitude-Avatar-Viewer') ?? '').trim();
    const requestedRevision = String(req.get('X-Finitude-Avatar-Revision') ?? '').trim();
    if (requestedViewer && requestedViewer !== authenticatedUserId) {
        throw Object.assign(new Error('The profile photo identity changed. Refresh the account.'), {
            statusCode: 409
        });
    }
    if (!requestedRevision) return;
    const parsedRevision = Number(requestedRevision);
    if (!Number.isSafeInteger(parsedRevision) || parsedRevision < 0) {
        throw Object.assign(new Error('A valid avatar revision is required.'), { statusCode: 400 });
    }
    if (parsedRevision !== revisionOf(user)) {
        throw Object.assign(new Error('The profile photo changed. Refresh the account.'), {
            statusCode: 409
        });
    }
};

/** Prevents a stale Web page from mutating the account that replaced its cookie session. */
export const assertAvatarMutationViewer = (req: Request, authenticatedUserId: string) => {
    const requestedViewer = String(req.get('X-Finitude-Avatar-Viewer') ?? '').trim();
    if (requestedViewer && requestedViewer !== authenticatedUserId) {
        throw Object.assign(new Error('The active account changed. Refresh the account.'), {
            statusCode: 409
        });
    }
};

/** Streams only the current avatar owned by the authenticated account. */
export const getAvatar = async (req: Request, res: Response, next: NextFunction) => {
    const auth = (req as AuthenticatedRequest).auth!;
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const user = await User.findById(auth.userId) as Record<string, any> | null;
    assertAvatarReadIdentity(req, auth.userId, user);
    const imageId = String(user?.avatarAssetId ?? '');
    if (!imageId) return res.status(404).json({ message: 'Avatar not found.' });

    const context = createMediaAbortContext(req, res);
    try {
        const result = await getAvatarObject(imageId, auth.userId, {
            ifNoneMatch: req.headers['if-none-match'],
            abortSignal: context.signal
        });
        if (!result) return res.status(404).json({ message: 'Avatar not found.' });
        if (result.notModified) {
            const requestedEtag = req.headers['if-none-match'];
            if (requestedEtag) res.setHeader('ETag', requestedEtag);
            return res.status(304).end();
        }
        const stream = result.object.Body as unknown as Readable | undefined;
        if (!stream || typeof stream.pipe !== 'function') {
            throw new Error('S3 avatar body is not a readable stream.');
        }
        res.setHeader('Content-Type', String(result.asset.contentType));
        // The app owns an account-scoped cache that it can erase on logout.
        // Shared URL caches must never retain authenticated avatar bytes.
        if (result.object.ETag) res.setHeader('ETag', result.object.ETag);
        if (result.object.ContentLength !== undefined) {
            res.setHeader('Content-Length', result.object.ContentLength);
        }
        await pipeMediaStream(req, res, stream, context);
        return;
    } catch (error: any) {
        if (context.aborted || error?.name === 'AbortError') return;
        if (res.headersSent) return res.destroy(error instanceof Error ? error : undefined);
        return next(error);
    } finally {
        context.cleanup();
    }
};

/** Runs the durable avatar operation after the bounded upload and viewer checks. */
export const putAvatar = async (req: Request, res: Response, next: NextFunction) => {
    const auth = (req as AuthenticatedRequest).auth!;
    try {
        assertAvatarMutationViewer(req, auth.userId);
        const { idempotencyKey, expectedRevision } = mutationHeaders(req);
        return sendMutationResult(res, await executeAvatarMutation(
            auth.userId, idempotencyKey, 'replace', expectedRevision, getUploadedFile(req, 'avatar')
        ));
    } catch (error) { return next(error); }
};

/** Resumes interrupted deletion without forgetting its private storage evidence. */
export const deleteAvatar = async (req: Request, res: Response, next: NextFunction) => {
    const auth = (req as AuthenticatedRequest).auth!;
    try {
        assertAvatarMutationViewer(req, auth.userId);
        const { idempotencyKey, expectedRevision } = mutationHeaders(req);
        return sendMutationResult(res, await executeAvatarMutation(
            auth.userId, idempotencyKey, 'delete', expectedRevision
        ));
    } catch (error) { return next(error); }
};
