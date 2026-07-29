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
import { requireAuth, requireAuthWhenPresented } from '../middleware/authMiddleware';
import {
    forgotPassword,
    register,
    resendVerification,
    resetPassword,
    verifyEmail
} from '../controllers/emailAuthController';
import {
    authenticateWithApple,
    authenticateWithGoogle
} from '../controllers/federatedAuthController';
import {
    deleteAccount,
    listSessions,
    revokeSession
} from '../controllers/accountController';
import {
    authenticationOptions,
    registrationOptions,
    verifyAuthentication,
    verifyRegistration
} from '../controllers/passkeyAuthController';

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
router.post(
    '/signup',
    authRateLimit,
    authAccountRateLimit,
    authConcurrencyLimit,
    body('email').trim().isEmail().normalizeEmail(),
    body('password').isLength({ min: 12, max: 256 }),
    body('displayName').optional().trim().isLength({ max: 80 }),
    asyncHandler(register)
);
router.post('/email/verify', authRateLimit, authAccountRateLimit, body('email').isEmail(), body('code').isLength({ min: 6, max: 6 }).isNumeric(), asyncHandler(verifyEmail));
router.post('/email/resend-verification', authRateLimit, authAccountRateLimit, body('email').isEmail(), asyncHandler(resendVerification));
router.post('/password/forgot', authRateLimit, authAccountRateLimit, body('email').isEmail(), asyncHandler(forgotPassword));
router.post('/password/reset', authRateLimit, authAccountRateLimit, authConcurrencyLimit, body('email').isEmail(), body('code').isLength({ min: 6, max: 6 }).isNumeric(), body('password').isLength({ min: 12, max: 256 }), asyncHandler(resetPassword));
router.post('/apple', authRateLimit, authAccountRateLimit, requireAuthWhenPresented, asyncHandler(authenticateWithApple));
router.post('/google', authRateLimit, authAccountRateLimit, requireAuthWhenPresented, asyncHandler(authenticateWithGoogle));

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
router.get('/sessions', requireAuth, asyncHandler(listSessions));
router.delete('/sessions/:id', requireAuth, asyncHandler(revokeSession));
router.delete('/account', requireAuth, asyncHandler(deleteAccount));
router.post('/passkeys/register/options', requireAuth, asyncHandler(registrationOptions));
router.post('/passkeys/register/verify', requireAuth, asyncHandler(verifyRegistration));
router.post('/passkeys/authenticate/options', authRateLimit, asyncHandler(authenticationOptions));
router.post('/passkeys/authenticate/verify', authRateLimit, asyncHandler(verifyAuthentication));

export default router;
