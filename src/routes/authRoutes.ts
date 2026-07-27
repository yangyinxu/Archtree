import express, { Router } from 'express';
import { body } from 'express-validator';
import { RequestHandler } from 'express';

import User from '../models/user';
import { signup, login, renderSignupPage, signupFromWeb, renderLoginPage, loginFromWeb, logoutFromWeb } from '../controllers/authController';
import { asyncHandler, authRateLimit } from '../middleware/requestProtectionMiddleware';

const router: Router = express.Router();

const signupValidation: RequestHandler[] = [
    body('email')
        .customSanitizer((value) => String(value ?? '').trim().toLowerCase())
        .isEmail()
        .withMessage('Please enter a valid email.')
        .custom((email, { req }) => {
            // check if the user has registered
            return User.findByEmail(email)
                .then(userDoc => {
                    if (userDoc) {
                        return Promise.reject('email address already exists!');
                    }
                });
        })
        .normalizeEmail(),
    body('password').trim().isLength({ min: 5, max: 256 }),
    body('username').trim().isLength({ min: 1, max: 64 })
];

router.put('/signup', authRateLimit, signupValidation, asyncHandler(signup));

router.get('/signup-web', renderSignupPage);

router.post('/signup-web', authRateLimit, signupValidation, asyncHandler(signupFromWeb));

router.get('/login-web', renderLoginPage);

router.post('/login-web', authRateLimit, asyncHandler(loginFromWeb));

router.post('/logout-web', logoutFromWeb);

router.post('/login', authRateLimit, asyncHandler(login));

export default router;
