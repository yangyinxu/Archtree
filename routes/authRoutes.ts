import express, { Router } from 'express';
import { body } from 'express-validator';
import { RequestHandler } from 'express';

import User from '../models/user';
import { signup, login } from '../controllers/authController';

const router: Router = express.Router();

const signupValidation: RequestHandler[] = [
    body('email')
        .isEmail()
        .withMessage('Please enter a valid email.')
        .custom((value, { req }) => {
            // check if the user has registered
            return User.findOne({ email: value }).then(userDoc => {
                if (userDoc) {
                    return Promise.reject('email address already exists!');
                }
            });
        })
        .normalizeEmail(),
    body('password').trim().isLength({ min: 5 }),
    body('name').trim().not().isEmpty()
];

router.put('/signup', signupValidation, signup);

router.post('/login', login);

export default router;