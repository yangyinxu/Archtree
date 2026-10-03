import express, { Router } from 'express';
import { body } from 'express-validator';
import { RequestHandler } from 'express';

import {
    login,
    refresh,
    logout,
    logoutAll,
    me,
    redirectToWebRegistration,
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
    authEmailAccountRateLimit,
    authRateLimit,
    browserRefreshRateLimit,
    refreshClientRateLimit,
    refreshCredentialRateLimit,
    requireSecureAuthTransport
} from '../middleware/requestProtectionMiddleware';
import {
    attachOptionalAuth,
    requireAuth,
    requireCurrentAccountViewer,
    requireAuthWhenPresented,
    requireBrowserAuth
} from '../middleware/authMiddleware';
import {
    completeRegistration,
    confirmEmailVerification,
    forgotPassword,
    inspectEmailVerification,
    inspectRegistration,
    requestEmailVerification,
    requestRegistration,
    resetPassword,
    retiredRegistrationEndpoint
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
import { avatarUpload, maxAvatarRequestMb } from '../middleware/imageUpload';
import { requireUploadSize } from '../middleware/audioUpload';
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

// Code-based registration moved to Web email links. These routes answer 410
// before validation, rate limiting or any database access, so no hijack path
// stays open and older clients show a clear message.
router.put('/signup', retiredRegistrationEndpoint);
router.post('/signup', retiredRegistrationEndpoint);
router.post('/email/verify', retiredRegistrationEndpoint);
router.post('/email/resend-verification', retiredRegistrationEndpoint);
router.post('/browser/register', retiredRegistrationEndpoint);
router.post('/browser/email/verify', retiredRegistrationEndpoint);
router.post('/browser/email/resend-verification', retiredRegistrationEndpoint);

// Email routes resolve the account from the normalized `email`, so their
// per-account limit runs after validation; see authEmailAccountRateLimit.
router.post('/password/forgot', authRateLimit, ...emailOnlyValidation, authEmailAccountRateLimit, asyncHandler(forgotPassword));
router.post('/password/reset', authRateLimit, authConcurrencyLimit, ...passwordResetValidation, authEmailAccountRateLimit, asyncHandler(resetPassword));
router.post('/apple', authRateLimit, authAccountRateLimit, requireAuthWhenPresented, asyncHandler(authenticateWithApple));
router.post('/google', authRateLimit, authAccountRateLimit, requireAuthWhenPresented, asyncHandler(authenticateWithGoogle));

// The Archtree sign-up page is retired; its POST body is ignored.
router.get('/signup-web', redirectToWebRegistration);
router.post('/signup-web', redirectToWebRegistration);

router.get('/login-web', attachOptionalAuth, renderLoginPage);

router.post('/login-web', requireSameOriginBrowserFormMutation, authRateLimit, authAccountRateLimit, authConcurrencyLimit, asyncHandler(loginFromWeb));

router.post('/logout-web', requireSameOriginBrowserFormMutation, asyncHandler(logoutFromWeb));

router.get('/browser/capabilities', (_req, res) => {
    setBrowserSessionPrivacyHeaders(res);
    res.status(200).json(getBrowserAuthenticationCapabilities());
});

// Registration requests hash no password, so they take no concurrency slot:
// every 429 they can return is independent of the address's account state.
router.post(
    '/browser/registration/request',
    requireSameOriginBrowserMutation,
    authRateLimit,
    ...emailOnlyValidation,
    authEmailAccountRateLimit,
    asyncHandler(requestRegistration)
);
router.post(
    '/browser/registration/inspect',
    requireSameOriginBrowserMutation,
    authRateLimit,
    asyncHandler(inspectRegistration)
);
router.post(
    '/browser/registration/complete',
    requireSameOriginBrowserMutation,
    authRateLimit,
    authConcurrencyLimit,
    asyncHandler(completeRegistration)
);
router.post(
    '/browser/email-verification/request',
    requireSameOriginBrowserMutation,
    authRateLimit,
    ...emailOnlyValidation,
    authEmailAccountRateLimit,
    asyncHandler(requestEmailVerification)
);
router.post(
    '/browser/email-verification/inspect',
    requireSameOriginBrowserMutation,
    authRateLimit,
    asyncHandler(inspectEmailVerification)
);
router.post(
    '/browser/email-verification/confirm',
    requireSameOriginBrowserMutation,
    authRateLimit,
    asyncHandler(confirmEmailVerification)
);
router.post(
    '/browser/password/forgot',
    requireSameOriginBrowserMutation,
    authRateLimit,
    ...emailOnlyValidation,
    authEmailAccountRateLimit,
    asyncHandler(forgotPassword)
);
router.post(
    '/browser/password/reset',
    requireSameOriginBrowserMutation,
    authRateLimit,
    authConcurrencyLimit,
    ...passwordResetValidation,
    authEmailAccountRateLimit,
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

// Refresh has its own buckets: sharing the login bucket let failed sign-ins
// from one address turn valid refreshes into 429s.
router.post('/refresh', refreshClientRateLimit, refreshCredentialRateLimit, asyncHandler(refresh));

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
    requireUploadSize(maxAvatarRequestMb),
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
