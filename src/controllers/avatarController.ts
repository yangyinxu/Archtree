import { NextFunction, Request, Response } from 'express';
import { Readable } from 'node:stream';
import { AuthenticatedRequest } from '../middleware/authMiddleware';
import { getUploadedFile } from '../middleware/imageUpload';
import User from '../models/user';
import {
    beginAvatarMutation,
    completeAvatarMutation,
    releaseAvatarMutation
} from '../services/avatarMutationService';
import {
    deleteAvatarAsset,
    getAvatarObject,
    uploadAvatar
} from '../services/avatarStorageService';
import { createMediaAbortContext, pipeMediaStream } from '../services/mediaDeliveryService';

const revisionOf = (user: Record<string, any> | null) => Number(user?.avatarRevision ?? 0);
const avatarProfile = (user: Record<string, any> | null) => {
    const avatarRevision = revisionOf(user);
    const assetId = String(user?.avatarAssetId ?? '');
    return {
        avatarRevision,
        avatar: assetId ? { assetId, revision: avatarRevision } : null
    };
};

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

/** Streams only the current avatar owned by the authenticated account. */
export const getAvatar = async (req: Request, res: Response, next: NextFunction) => {
    const auth = (req as AuthenticatedRequest).auth!;
    const user = await User.findById(auth.userId) as Record<string, any> | null;
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
        res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
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

/** Replaces an avatar with idempotent, revision-checked lifecycle semantics. */
export const putAvatar = async (req: Request, res: Response, next: NextFunction) => {
    const auth = (req as AuthenticatedRequest).auth!;
    let mutationId = '';
    try {
        const { idempotencyKey, expectedRevision } = mutationHeaders(req);
        const mutation = await beginAvatarMutation(auth.userId, idempotencyKey, 'replace', expectedRevision);
        mutationId = mutation.mutationId;
        if (!mutation.isOwner && mutation.result) return sendMutationResult(res, mutation.result);

        const uploadFile = getUploadedFile(req, 'avatar');
        if (!uploadFile) {
            const result = { statusCode: 400, body: { message: 'Select an avatar image to upload.' } };
            await completeAvatarMutation(mutationId, result);
            return sendMutationResult(res, result);
        }
        const user = await User.findById(auth.userId) as Record<string, any> | null;
        if (!user) {
            const result = { statusCode: 404, body: { message: 'Account not found.' } };
            await completeAvatarMutation(mutationId, result);
            return sendMutationResult(res, result);
        }
        if (revisionOf(user) !== expectedRevision) {
            const result = { statusCode: 409, body: { message: 'Avatar changed on another device.', ...avatarProfile(user) } };
            await completeAvatarMutation(mutationId, result);
            return sendMutationResult(res, result);
        }

        const replacementId = await uploadAvatar(auth.userId, uploadFile);
        const previousId = String(user.avatarAssetId ?? '');
        const replacement = await User.replaceAvatar(auth.userId, expectedRevision, replacementId);
        const previousUser = replacement.value as Record<string, any> | null;
        if (!previousUser) {
            await deleteAvatarAsset(replacementId, auth.userId).catch(() => undefined);
            const current = await User.findById(auth.userId) as Record<string, any> | null;
            const result = { statusCode: 409, body: { message: 'Avatar changed on another device.', ...avatarProfile(current) } };
            await completeAvatarMutation(mutationId, result);
            return sendMutationResult(res, result);
        }

        let cleanupPending = false;
        if (previousId && previousId !== replacementId) {
            try {
                await deleteAvatarAsset(previousId, auth.userId);
            } catch {
                cleanupPending = true;
            }
        }
        const revision = expectedRevision + 1;
        const result = {
            statusCode: 200,
            body: {
                avatarRevision: revision,
                avatar: { assetId: replacementId, revision },
                cleanupPending
            }
        };
        await completeAvatarMutation(mutationId, result);
        return sendMutationResult(res, result);
    } catch (error) {
        if (mutationId) await releaseAvatarMutation(mutationId).catch(() => undefined);
        return next(error);
    }
};

/** Removes the current avatar only after its private S3 object is confirmed deleted. */
export const deleteAvatar = async (req: Request, res: Response, next: NextFunction) => {
    const auth = (req as AuthenticatedRequest).auth!;
    let mutationId = '';
    try {
        const { idempotencyKey, expectedRevision } = mutationHeaders(req);
        const mutation = await beginAvatarMutation(auth.userId, idempotencyKey, 'delete', expectedRevision);
        mutationId = mutation.mutationId;
        if (!mutation.isOwner && mutation.result) return sendMutationResult(res, mutation.result);

        const user = await User.findById(auth.userId) as Record<string, any> | null;
        if (!user) {
            const result = { statusCode: 404, body: { message: 'Account not found.' } };
            await completeAvatarMutation(mutationId, result);
            return sendMutationResult(res, result);
        }
        if (revisionOf(user) !== expectedRevision) {
            const result = { statusCode: 409, body: { message: 'Avatar changed on another device.', ...avatarProfile(user) } };
            await completeAvatarMutation(mutationId, result);
            return sendMutationResult(res, result);
        }
        const imageId = String(user.avatarAssetId ?? '');
        if (!imageId) {
            const result = {
                statusCode: 200,
                body: { avatarRevision: expectedRevision, avatar: null }
            };
            await completeAvatarMutation(mutationId, result);
            return sendMutationResult(res, result);
        }

        await deleteAvatarAsset(imageId, auth.userId);
        const cleared = await User.clearAvatar(auth.userId, expectedRevision, imageId);
        if (!cleared.value) {
            const current = await User.findById(auth.userId) as Record<string, any> | null;
            const result = { statusCode: 409, body: { message: 'Avatar changed on another device.', ...avatarProfile(current) } };
            await completeAvatarMutation(mutationId, result);
            return sendMutationResult(res, result);
        }
        const result = {
            statusCode: 200,
            body: { avatarRevision: expectedRevision + 1, avatar: null }
        };
        await completeAvatarMutation(mutationId, result);
        return sendMutationResult(res, result);
    } catch (error) {
        if (mutationId) await releaseAvatarMutation(mutationId).catch(() => undefined);
        return next(error);
    }
};
