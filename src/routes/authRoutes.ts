import express, { Router } from 'express';
import { body } from 'express-validator';
import { RequestHandler } from 'express';

import User from '../models/user';
import {
    signup,
    login,
    refresh,
    logout,
    logoutAll,
    me,
    renderSignupPage,
    signupFromWeb,
    renderLoginPage,
    loginFromWeb,
    logoutFromWeb
} from '../controllers/authController';
import {
    asyncHandler,
    authAccountRateLimit,
    authConcurrencyLimit,
    authRateLimit,
    requireSecureAuthTransport
} from '../middleware/requestProtectionMiddleware';
import { requireAuth } from '../middleware/authMiddleware';

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
    body('password').isLength({ min: 12, max: 256 }),
    body('username').trim().isLength({ min: 1, max: 64 })
];

router.use(requireSecureAuthTransport);

router.put('/signup', authRateLimit, authAccountRateLimit, authConcurrencyLimit, signupValidation, asyncHandler(signup));

router.get('/signup-web', renderSignupPage);

router.post('/signup-web', authRateLimit, authAccountRateLimit, authConcurrencyLimit, signupValidation, asyncHandler(signupFromWeb));

router.get('/login-web', renderLoginPage);

router.post('/login-web', authRateLimit, authAccountRateLimit, authConcurrencyLimit, asyncHandler(loginFromWeb));

router.post('/logout-web', asyncHandler(logoutFromWeb));

router.post('/login', authRateLimit, authAccountRateLimit, authConcurrencyLimit, asyncHandler(login));

router.post('/refresh', authRateLimit, asyncHandler(refresh));

router.post('/logout', authRateLimit, asyncHandler(logout));

router.post('/logout-all', requireAuth, asyncHandler(logoutAll));

router.get('/me', requireAuth, asyncHandler(me));

export default router;
