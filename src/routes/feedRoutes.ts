import express, { Router } from 'express';
import { body } from 'express-validator';
import { RequestHandler } from 'express';

import { getPosts, createPost } from '../controllers/feedController';

const router: Router = express.Router();

const createPostValidation: RequestHandler[] = [
    body('title')
        .trim()
        .isLength({ min: 5 }),
    body('content')
        .trim()
        .isLength({ min: 5})
];

router.get('/posts', getPosts);

router.post('/post', createPostValidation, createPost);

export default router;