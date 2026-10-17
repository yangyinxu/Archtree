import express, { Router } from 'express';

import { setBrowserSessionPrivacyHeaders } from '../services/auth/authCookieService';
import {
    renderForgotPasswordPage,
    renderRegisterCompletePage,
    renderRegisterPage,
    renderResetPasswordPage,
    renderVerifyEmailPage
} from '../views/account/accountViews';

/**
 * Kashewt account pages mounted at `/account`. They render static shells only;
 * every account change goes through the rate-limited `/auth/browser/*`
 * endpoints, and email-link tokens stay in the URL fragment, which is never
 * sent to the server.
 */
export const createAccountPageRouter = (): Router => {
    const router = express.Router();
    router.use((_req, res, next) => {
        setBrowserSessionPrivacyHeaders(res);
        next();
    });
    router.get('/register', (_req, res) => res.status(200).type('html').send(renderRegisterPage()));
    router.get('/register/complete', (_req, res) => res.status(200).type('html').send(renderRegisterCompletePage()));
    router.get('/verify-email', (_req, res) => res.status(200).type('html').send(renderVerifyEmailPage()));
    router.get('/forgot-password', (_req, res) => res.status(200).type('html').send(renderForgotPasswordPage()));
    router.get('/reset-password', (_req, res) => res.status(200).type('html').send(renderResetPasswordPage()));
    return router;
};
