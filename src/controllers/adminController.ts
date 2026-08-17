import { Request, Response, NextFunction } from 'express';
import { getDb } from '../infrastructure/database';
import { reconcileAudioStorage } from '../services/audioReconciliationService';
import { AuthenticatedRequest } from '../middleware/authMiddleware';
import { renderAudioStorageAuditPage } from '../views/admin/audioStorageAuditView';
import { reconcileImageStorage } from '../services/imageReconciliationService';
import { reconcileContentReferences } from '../services/contentReferenceReconciliationService';
import {
    normalizeAudioPublicationRetryIds,
    retryAudioTrackPublications
} from '../services/audioPublicationRecoveryService';
import {
    AudioStorageRemediationError,
    deleteMissingAudioTrackRecord,
    deleteOrphanedAudioStorageObject
} from '../services/audioStorageRemediationService';

const isBrowserFormRequest = (req: Request) => typeof req.is === 'function'
    && Boolean(req.is('application/x-www-form-urlencoded'));

const audioAuditRedirect = (res: Response, message: string, isError: boolean = false) =>
    res.redirect(303, `/admin/audio-storage/reconciliation?message=${encodeURIComponent(message)}${isError ? '&error=1' : ''}`);

// {{baseUrl}}/admin/product
export const getAddProduct = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 50));
        const offset = Math.max(0, Number(req.query.offset) || 0);
        const products = await getDb()!
            .collection('products')
            .find()
            .skip(offset)
            .limit(limit)
            .toArray();
        return res.status(200).json({ products, limit, offset });
    } catch (error) {
        return next(error);
    }
};

// {{baseUrl}}/admin/product
export const postAddProduct = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const product = {
            title: String(req.body.title ?? '').trim(),
            imageUrl: String(req.body.imageUrl ?? '').trim(),
            price: Number(req.body.price),
            description: String(req.body.description ?? '').trim()
        };
        if (!product.title || !product.imageUrl || !Number.isFinite(product.price)) {
            return res.status(400).json({ message: 'Valid title, imageUrl, and price are required.' });
        }
        const result = await getDb()!.collection('products').insertOne(product);
        return res.status(201).json({
            message: `Product ${product.title} Added Successfully`,
            productId: result.insertedId
        });
    } catch (error) {
        return next(error);
    }
};

export const getAudioStorageReconciliation = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const report = await reconcileAudioStorage();
        res.setHeader('Cache-Control', 'no-store');
        const preferredFormat = req.query.format === 'json'
            ? 'json'
            : req.accepts(['html', 'json']);
        if (preferredFormat === 'html') {
            const auth = (req as AuthenticatedRequest).auth;
            return res.status(200).send(renderAudioStorageAuditPage(
                report,
                auth?.email ?? 'Administrator',
                String(req.query.message ?? '').slice(0, 500),
                req.query.error === '1'
            ));
        }
        return res.status(200).json(report);
    } catch (error) {
        return next(error);
    }
};

export const getImageStorageReconciliation = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const report = await reconcileImageStorage();
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).json(report);
    } catch (error) {
        return next(error);
    }
};

export const getContentReferenceReconciliation = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const report = await reconcileContentReferences();
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).json(report);
    } catch (error) {
        return next(error);
    }
};

/** Retries publication from existing ready storage without accepting another upload. */
export const postAudioPublicationRetry = async (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    try {
        res.setHeader('Cache-Control', 'no-store');
        const source = Array.isArray(req.body?.audioTrackIds)
            ? req.body.audioTrackIds
            : typeof req.body?.audioTrackIds === 'string'
                ? req.body.audioTrackIds.split(',')
                : [];
        let audioTrackIds: string[];
        try {
            audioTrackIds = normalizeAudioPublicationRetryIds(source);
        } catch (error) {
            if (isBrowserFormRequest(req)) {
                return audioAuditRedirect(
                    res,
                    error instanceof Error ? error.message : 'Invalid publication retry request.',
                    true
                );
            }
            return res.status(400).json({
                message: error instanceof Error ? error.message : 'Invalid publication retry request.'
            });
        }
        const report = await retryAudioTrackPublications(audioTrackIds);
        if (isBrowserFormRequest(req)) {
            return audioAuditRedirect(
                res,
                report.failedCount === 0
                    ? `${report.readyCount} Soundtrack publication${report.readyCount === 1 ? '' : 's'} completed.`
                    : `${report.readyCount} publication${report.readyCount === 1 ? '' : 's'} completed; ${report.failedCount} still need attention.`,
                report.failedCount > 0
            );
        }
        return res.status(200).json(report);
    } catch (error) {
        return next(error);
    }
};

/** Deletes one report-confirmed orphan while preserving any raw lifecycle reference. */
export const postAudioOrphanDelete = async (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    try {
        res.setHeader('Cache-Control', 'no-store');
        const result = await deleteOrphanedAudioStorageObject(req.body?.s3Key);
        const message = result.status === 'alreadyAbsent'
            ? 'The orphaned S3 object was already absent. The action is complete.'
            : 'The orphaned S3 object was deleted successfully.';
        if (isBrowserFormRequest(req)) return audioAuditRedirect(res, message);
        return res.status(200).json({ message, ...result });
    } catch (error) {
        if (error instanceof AudioStorageRemediationError) {
            if (isBrowserFormRequest(req)) {
                return audioAuditRedirect(res, error.message, true);
            }
            return res.status(error.statusCode).json({
                message: error.message,
                code: error.code,
                reconciliationRequired: error.outcomeUnknown
            });
        }
        return next(error);
    }
};

/** Deletes one report-confirmed MongoDB-only Soundtrack through the shared deletion lifecycle. */
export const postAudioMissingTrackDelete = async (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    try {
        res.setHeader('Cache-Control', 'no-store');
        const result = await deleteMissingAudioTrackRecord(
            req.body?.audioTrackId,
            req.body?.expectedS3Key
        );
        const message = result.status === 'alreadyAbsent'
            ? 'The MongoDB Soundtrack record was already absent. The action is complete.'
            : result.cleanupPending
                ? 'The MongoDB Soundtrack record and catalog references were deleted. Cover-art cleanup still requires reconciliation.'
                : 'The MongoDB Soundtrack record and catalog references were deleted successfully.';
        if (isBrowserFormRequest(req)) return audioAuditRedirect(res, message);
        return res.status(200).json({ message, ...result });
    } catch (error) {
        if (error instanceof AudioStorageRemediationError) {
            if (isBrowserFormRequest(req)) {
                return audioAuditRedirect(res, error.message, true);
            }
            return res.status(error.statusCode).json({
                message: error.message,
                code: error.code,
                reconciliationRequired: error.outcomeUnknown
            });
        }
        return next(error);
    }
};
