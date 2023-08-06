import { RequestHandler } from 'express';
import { validationResult } from 'express-validator';
import Post from '../models/post';
import { ObjectId } from 'mongodb';

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
    // TODO: replace with actual imageUrl and creator
    const post: Post = new Post(
        postData.title,
        postData.content,
        ['https://culverduck.com/wp-content/uploads/2020/11/duck-animate-1-500x500.png'],
        new ObjectId('5f9f3b9b9b0b3b1f0c3b3b1f'),
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