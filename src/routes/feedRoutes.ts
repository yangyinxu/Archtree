import express, { Router } from 'express';
import { body } from 'express-validator';
import { RequestHandler } from 'express';

// import all the functions from the feedController
import * as feedController from '../controllers/feedController';

const router: Router = express.Router();

// validate that the title and description both have a minimum length of 5 characters
const createPostValidation: RequestHandler[] = [
    body('title')
        .trim()
        .isLength({ min: 5 }),
    body('description')
        .trim()
        .isLength({ min: 5})
];

// Get a single post
router.get('/post', feedController.getPost);

// Get all posts
router.get('/posts', feedController.getPosts);

// Create a post
router.post('/post', createPostValidation, feedController.createPost);

// Delete a post
router.delete('/post', feedController.deletePost);

export default router;