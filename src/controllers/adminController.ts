import { Request, Response, NextFunction } from 'express';
import { getDb } from '../infrastructure/database';
import { reconcileAudioStorage } from '../services/audioReconciliationService';
import { AuthenticatedRequest } from '../middleware/authMiddleware';
import { renderAudioStorageAuditPage } from '../views/admin/audioStorageAuditView';
import { reconcileImageStorage } from '../services/imageReconciliationService';

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
            return res.status(200).send(renderAudioStorageAuditPage(report, auth?.email ?? 'Administrator'));
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
