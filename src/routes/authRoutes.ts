import express, { Router } from 'express';
import { body } from 'express-validator';
import { RequestHandler } from 'express';

import {
    login,
    refresh,
    logout,
    logoutAll,
    me,
    renderSignupPage,
    signupFromWeb,
    renderLoginPage,
    loginFromWeb,
    logoutFromWeb,
    browserLogin,
    browserLogout,
    browserRefresh,
    browserSession
} from '../controllers/authController';
import {
    asyncHandler,
    authAccountRateLimit,
    authConcurrencyLimit,
    authRateLimit,
    browserRefreshRateLimit,
    requireSecureAuthTransport
} from '../middleware/requestProtectionMiddleware';
import {
    requireAuth,
    requireCurrentAccountViewer,
    requireAuthWhenPresented,
    requireBrowserAuth
} from '../middleware/authMiddleware';
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
    changePassword,
    clearListeningHistory,
    deleteAccount,
    listSessions,
    revokeSession,
    unlinkProvider
} from '../controllers/accountController';
import {
    authenticationOptions,
    registrationOptions,
    verifyAuthentication,
    verifyRegistration
} from '../controllers/passkeyAuthController';
import {
    getAuthenticationCapabilities,
    getBrowserAuthenticationCapabilities
} from '../services/authCapabilitiesService';
import { requireAcceptablePassword } from '../services/passwordPolicyService';
import { deleteAvatar, getAvatar, putAvatar } from '../controllers/avatarController';
import { avatarUpload } from '../middleware/imageUpload';
import {
    uploadConcurrencyLimit,
    uploadRateLimit
} from '../middleware/requestProtectionMiddleware';
import { limitMediaConcurrencyFor } from '../middleware/mediaDeliveryMiddleware';
import {
    requireBrowserRefreshCookie,
    requireBrowserSessionTransitionCapability,
    requireSameOriginBrowserFormMutation,
    requireSameOriginBrowserMutation,
    setBrowserSessionPrivacyHeaders
} from '../services/authCookieService';

const router: Router = express.Router();

const signupWebValidation: RequestHandler[] = [
    body('email')
        .customSanitizer((value) => String(value ?? '').trim().toLowerCase())
        .isEmail()
        .withMessage('Please enter a valid email.')
        .normalizeEmail(),
    body('password').custom(requireAcceptablePassword),
    body('username').trim().isLength({ min: 1, max: 64 })
];

const emailRegistrationValidation: RequestHandler[] = [
    body('email')
        .customSanitizer((value) => String(value ?? '').trim().toLowerCase())
        .isEmail()
        .normalizeEmail(),
    body('password').custom(requireAcceptablePassword),
    body('displayName').optional().trim().isLength({ max: 80 })
];

const emailOnlyValidation: RequestHandler[] = [
    body('email')
        .customSanitizer((value) => String(value ?? '').trim().toLowerCase())
        .isEmail()
        .normalizeEmail()
];

const emailCodeValidation: RequestHandler[] = [
    ...emailOnlyValidation,
    body('code').trim().isLength({ min: 6, max: 6 }).isNumeric()
];

const passwordResetValidation: RequestHandler[] = [
    ...emailCodeValidation,
    body('password').custom(requireAcceptablePassword)
];

router.use(requireSecureAuthTransport);
router.get('/capabilities', (_req, res) => {
    res.status(200).json(getAuthenticationCapabilities());
});

router.put('/signup', (_req, res) => {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ message: 'Use POST /auth/signup.' });
});
router.post(
    '/signup',
    authRateLimit,
    authAccountRateLimit,
    authConcurrencyLimit,
    ...emailRegistrationValidation,
    asyncHandler(register)
);
router.post('/email/verify', authRateLimit, authAccountRateLimit, ...emailCodeValidation, asyncHandler(verifyEmail));
router.post('/email/resend-verification', authRateLimit, authAccountRateLimit, ...emailOnlyValidation, asyncHandler(resendVerification));
router.post('/password/forgot', authRateLimit, authAccountRateLimit, ...emailOnlyValidation, asyncHandler(forgotPassword));
router.post('/password/reset', authRateLimit, authAccountRateLimit, authConcurrencyLimit, ...passwordResetValidation, asyncHandler(resetPassword));
router.post('/apple', authRateLimit, authAccountRateLimit, requireAuthWhenPresented, asyncHandler(authenticateWithApple));
router.post('/google', authRateLimit, authAccountRateLimit, requireAuthWhenPresented, asyncHandler(authenticateWithGoogle));

router.get('/signup-web', renderSignupPage);

router.post('/signup-web', requireSameOriginBrowserFormMutation, authRateLimit, authAccountRateLimit, authConcurrencyLimit, signupWebValidation, asyncHandler(signupFromWeb));

router.get('/login-web', renderLoginPage);

router.post('/login-web', requireSameOriginBrowserFormMutation, authRateLimit, authAccountRateLimit, authConcurrencyLimit, asyncHandler(loginFromWeb));

router.post('/logout-web', requireSameOriginBrowserFormMutation, asyncHandler(logoutFromWeb));

router.get('/browser/capabilities', (_req, res) => {
    setBrowserSessionPrivacyHeaders(res);
    res.status(200).json(getBrowserAuthenticationCapabilities());
});

router.post(
    '/browser/register',
    requireSameOriginBrowserMutation,
    authRateLimit,
    authAccountRateLimit,
    authConcurrencyLimit,
    ...emailRegistrationValidation,
    asyncHandler(register)
);
router.post(
    '/browser/email/verify',
    requireSameOriginBrowserMutation,
    authRateLimit,
    authAccountRateLimit,
    ...emailCodeValidation,
    asyncHandler(verifyEmail)
);
router.post(
    '/browser/email/resend-verification',
    requireSameOriginBrowserMutation,
    authRateLimit,
    authAccountRateLimit,
    ...emailOnlyValidation,
    asyncHandler(resendVerification)
);
router.post(
    '/browser/password/forgot',
    requireSameOriginBrowserMutation,
    authRateLimit,
    authAccountRateLimit,
    ...emailOnlyValidation,
    asyncHandler(forgotPassword)
);
router.post(
    '/browser/password/reset',
    requireSameOriginBrowserMutation,
    authRateLimit,
    authAccountRateLimit,
    authConcurrencyLimit,
    ...passwordResetValidation,
    asyncHandler(resetPassword)
);

router.post(
    '/browser/login',
    requireSameOriginBrowserMutation,
    requireBrowserSessionTransitionCapability,
    authRateLimit,
    authAccountRateLimit,
    authConcurrencyLimit,
    asyncHandler(browserLogin)
);
router.post(
    '/browser/refresh',
    requireSameOriginBrowserMutation,
    requireBrowserSessionTransitionCapability,
    requireBrowserRefreshCookie,
    browserRefreshRateLimit,
    asyncHandler(browserRefresh)
);
router.get('/browser/session', requireBrowserAuth, asyncHandler(browserSession));
router.post(
    '/browser/logout',
    requireSameOriginBrowserMutation,
    asyncHandler(browserLogout)
);

router.post('/login', authRateLimit, authAccountRateLimit, authConcurrencyLimit, asyncHandler(login));

router.post('/refresh', authRateLimit, asyncHandler(refresh));

router.post('/logout', authRateLimit, asyncHandler(logout));

router.post('/logout-all', requireAuth, requireCurrentAccountViewer, asyncHandler(logoutAll));

router.get('/me', requireAuth, requireCurrentAccountViewer, asyncHandler(me));
router.get(
    '/avatar',
    requireAuth,
    requireCurrentAccountViewer,
    limitMediaConcurrencyFor('avatar'),
    asyncHandler(getAvatar)
);
router.put(
    '/avatar',
    requireAuth,
    requireCurrentAccountViewer,
    uploadRateLimit,
    uploadConcurrencyLimit,
    avatarUpload.single('avatar'),
    asyncHandler(putAvatar)
);
router.delete(
    '/avatar',
    requireAuth,
    requireCurrentAccountViewer,
    uploadRateLimit,
    uploadConcurrencyLimit,
    asyncHandler(deleteAvatar)
);
router.get('/sessions', requireAuth, requireCurrentAccountViewer, asyncHandler(listSessions));
router.delete('/sessions/:id', requireAuth, requireCurrentAccountViewer, asyncHandler(revokeSession));
router.post(
    '/password/change',
    authRateLimit,
    authConcurrencyLimit,
    requireAuth,
    requireCurrentAccountViewer,
    body('currentPassword').optional().isString().isLength({ max: 256 }),
    body('newPassword').custom(requireAcceptablePassword),
    asyncHandler(changePassword)
);
router.delete(
    '/activity/listening-history',
    requireAuth,
    requireCurrentAccountViewer,
    asyncHandler(clearListeningHistory)
);
router.delete('/identities/:provider', requireAuth, requireCurrentAccountViewer, asyncHandler(unlinkProvider));
router.delete('/account', requireAuth, requireCurrentAccountViewer, asyncHandler(deleteAccount));
router.post('/passkeys/register/options', requireAuth, requireCurrentAccountViewer, asyncHandler(registrationOptions));
router.post('/passkeys/register/verify', requireAuth, requireCurrentAccountViewer, asyncHandler(verifyRegistration));
router.post('/passkeys/authenticate/options', authRateLimit, asyncHandler(authenticationOptions));
router.post('/passkeys/authenticate/verify', authRateLimit, asyncHandler(verifyAuthentication));

export default router;
