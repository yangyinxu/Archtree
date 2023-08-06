import { Request, Response, NextFunction } from 'express';
import { getDb } from '../app';

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