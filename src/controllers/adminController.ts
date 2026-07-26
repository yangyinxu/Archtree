import { Request, Response, NextFunction } from 'express';
import { getDb } from '../infrastructure/database';
import { reconcileAudioStorage } from '../services/audioReconciliationService';
import { AuthenticatedRequest } from '../middleware/authMiddleware';
import { renderAudioStorageAuditPage } from '../views/admin/audioStorageAuditView';

const Product = require('../models/product');

// {{baseUrl}}/admin/product
export const getAddProduct = async (req: Request, res: Response, next: NextFunction) => {
    // retrieve all products from database
    const db = getDb();

    if (db === undefined) {
        console.log('Invalid Database');
        return;
    }

    db!.collection('products')
        .find()
        .toArray()
        .then((products: any) => {
            console.log(products);
            res.status(200).json({ products: products });
        })
        .catch((error: any) => {
            console.log(error);
            res.status(500).json({ message: 'An error occurred.' });
        });
};

// {{baseUrl}}/admin/product
export const postAddProduct = (req: Request, res: Response, next: () => void) => {
    const title: string = req.body.title;
    const imageUrl: string = req.body.imageUrl;
    const price: number = req.body.price;
    const description: string = req.body?.description;

    const product = new Product(
        title,
        price,
        description,
        imageUrl);

    product
        .save()
        .then((result: any) => {
            console.log(result);
            res.status(201).json({
                message: `Product ${title} Added Successfully`,
                product: result
            });
        })
        .catch((err: any) => {
            console.log(err);
        });
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
