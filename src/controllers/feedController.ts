import { RequestHandler } from 'express';
import { validationResult } from 'express-validator';
import Post, { PostDocument } from '../models/post';
import { Types } from 'mongoose';

interface PostData {
    _id: string;
    title: string;
    content: string;
    creator: {
        name: string;
    };
    createdAt: Date;
}

interface CreatePostData {
    title: string;
    content: string;
}

export const getPosts: RequestHandler = (req, res, next) => {
    const posts: PostData[] = [
        {
            _id: '1',
            title: 'First post',
            content: 'This is the first post!',
            creator: {
                name: "testCreator"
            },
            createdAt: new Date()
        }
    ];

    res.status(200).json({
        posts
    });
};

export const createPost: RequestHandler = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(422).json({
            message: 'Validation failed, entered data is incorrect.',
            errors: errors.array()
        });
    }

    const postData: CreatePostData = req.body;
    
    const post: PostDocument = new Post({
        title: postData.title,
        content: postData.content,
        imageUrl: 'https://culverduck.com/wp-content/uploads/2020/11/duck-animate-1-500x500.png',
        creator: { name: "testCreator"}
    });

    post.save()
        .then((result: PostDocument) => {
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