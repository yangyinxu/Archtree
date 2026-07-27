import { NextFunction, Request, Response } from 'express';
import { validationResult } from 'express-validator';
import { ObjectId } from 'mongodb';
import Post from '../models/post';
import { getDb } from '../infrastructure/database';
import { AuthenticatedRequest } from '../middleware/authMiddleware';

export const getPost = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const rawPostId = String(req.query.postId ?? '');
        if (!ObjectId.isValid(rawPostId)) {
            return res.status(400).json({ error: 'Invalid postId' });
        }
        const post = await getDb()!.collection('posts').findOne({
            _id: ObjectId.createFromHexString(rawPostId)
        });
        return res.status(post ? 200 : 404).json({ post });
    } catch (error) {
        return next(error);
    }
};

export const getPosts = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 50));
        const offset = Math.max(0, Number(req.query.offset) || 0);
        const posts = await getDb()!
            .collection('posts')
            .find()
            .sort({ createdAt: -1 })
            .skip(offset)
            .limit(limit)
            .toArray();
        return res.status(200).json({ posts, limit, offset });
    } catch (error) {
        return next(error);
    }
};

export const createPost = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(422).json({
                message: 'Validation failed, entered data is incorrect.',
                errors: errors.array()
            });
        }
        const auth = (req as AuthenticatedRequest).auth;
        if (!auth) return res.status(401).json({ message: 'Unauthorized.' });

        const post = new Post(
            String(req.body.title ?? ''),
            String(req.body.description ?? ''),
            String(req.body.mainImageUrl ?? ''),
            Array.isArray(req.body.imageUrls) ? req.body.imageUrls.map(String).slice(0, 20) : [],
            ObjectId.createFromHexString(auth.userId),
            new Date()
        );
        const result = await post.save();
        return res.status(201).json({
            message: 'Post created successfully!',
            postId: result.insertedId
        });
    } catch (error) {
        return next(error);
    }
};

export const deletePost = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const rawPostId = String(req.query.postId ?? '');
        if (!ObjectId.isValid(rawPostId)) {
            return res.status(400).json({ error: 'Invalid postId' });
        }
        const auth = (req as AuthenticatedRequest).auth;
        if (!auth) return res.status(401).json({ message: 'Unauthorized.' });

        const postId = ObjectId.createFromHexString(rawPostId);
        const filter = auth.role === 'admin'
            ? { _id: postId }
            : { _id: postId, userId: ObjectId.createFromHexString(auth.userId) };
        const result = await getDb()!.collection('posts').deleteOne(filter);
        if (result.deletedCount !== 1) {
            return res.status(404).json({ message: 'Post not found or cannot be deleted.' });
        }
        return res.status(200).json({ message: 'Post deleted successfully!' });
    } catch (error) {
        return next(error);
    }
};
