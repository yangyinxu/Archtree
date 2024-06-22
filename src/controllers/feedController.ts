import { RequestHandler, Request, Response, NextFunction } from 'express';
import { validationResult } from 'express-validator';
import Post from '../models/post';
import { ObjectId } from 'mongodb';
import { getDb } from '../app';

interface CreatePostData {
    creatorId: string;
    title: string;
    description: string;
    mainImageUrl: string;
    imageUrls: string[];
    createdAt: Date;
}

// Get a single post
export const getPost: RequestHandler = async (req: Request, res: Response, next: () => void) => {
    let postId: ObjectId;
    try {
        postId = ObjectId.createFromHexString(req.query.postId as string); // Convert string to ObjectId
    } catch (error) {
        console.error('Invalid postId:', req.query.postId);
        return res.status(400).json({ error: 'Invalid postId' });
    }

    try {
        const db = getDb();
        db!.collection('posts')
            .findOne({ _id: postId })
            .then(post => {
                res.status(200).json({
                    post
                });
            })
            .catch(error => {
                console.log(error);
            });
    } catch (error) {
        return res.status(500).json({ error: 'Unexpected error' });
    }
}

// Get all posts
export const getPosts: RequestHandler = (req, res, next) => {
    // use express-validator to validate the input
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(422).json({
            message: 'Validation failed, entered data is incorrect.',
            errors: errors.array()
        });
    }

    // Fetch all posts from the database
    const db = getDb();
    db!.collection('posts')
        .find()
        .toArray()
        .then(posts => {
            res.status(200).json({
                posts
            });
        })
        .catch(error => {
            console.log(error);
        });
};

// Create a new post
export const createPost: RequestHandler = (req, res, next) => {
    // use express-validator to validate the input
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(422).json({
            message: 'Validation failed, entered data is incorrect.',
            errors: errors.array()
        });
    }

    const postData: CreatePostData = req.body;

    // create a new post
    // Convert the creatorId string to an ObjectId
    const creatorId = ObjectId.createFromHexString(postData.creatorId);
    const post: Post = new Post(
        postData.title,
        postData.description,
        postData.mainImageUrl,
        postData.imageUrls,
        creatorId,
        new Date()
    );

    // save the post to the database
    post.save()
        .then((result) => {
            console.log(result);
            res.status(201).json({
                message: 'Post created successfully!',
                post: result
            });
        })
        .catch(error => {
            console.log(error);
        });
};

// Delete a post by id
export const deletePost: RequestHandler = async (req, res, next) => {
    let postId: ObjectId;
    try {
        postId = ObjectId.createFromHexString(req.query.postId as string); // Convert string to ObjectId
    } catch (error) {
        console.error('Invalid postId:', req.query.postId);
        return res.status(400).json({ error: 'Invalid postId' });
    }

    try {
        const db = getDb();
        db!.collection('posts')
            .deleteOne({ _id: postId })
            .then(result => {
                console.log(result);
                res.status(200).json({ message: 'Post deleted successfully!' });
            })
            .catch(error => {
                console.log(error);
            });
    } catch (error) {
        return res.status(500).json({ error: 'Unexpected error' });
    }
}