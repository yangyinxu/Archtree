import { NextFunction, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { validationResult } from 'express-validator';
import AuthActionToken from '../models/authActionToken';
import EmailLinkToken, { isEmailLinkTokenFormat } from '../models/emailLinkToken';
import User from '../models/user';
import {
    requireAuthEmailConfiguration,
    requireAuthLinkConfiguration,
    sendAuthEmail
} from '../services/authEmailService';
import { applyPasswordReset } from '../services/authCredentialService';
import { checkEmailDomainDeliverability } from '../services/emailDomainDeliverability';
import {
    completeEmailRegistration,
    confirmEmailVerificationLink,
    inspectEmailVerificationLink,
    sendAlreadyRegisteredNotice,
    sendRegistrationLink,
    sendSignInVerificationEmail,
    sendVerificationLink
} from '../services/emailLinkService';
import {
    EmailVerificationSubject,
    emailVerificationState,
    signInVerificationRequiredMessage
} from '../services/emailVerificationService';
import { evaluatePassword } from '../services/passwordPolicyService';
import {
    AuthenticationMethod,
    recordAuthFunnelEvent,
    recordSecurityEvent
} from '../services/securityAuditService';
import { runRequestWork } from '../services/serverLifecycleService';

const normalizeEmail = (value: unknown) => String(value ?? '').trim().toLowerCase();
const recoveryAcceptedMessage = { message: 'If the account can use this action, an email has been sent.' };
const registrationAcceptedMessage = { message: 'Check your email for the next step.' };
const verificationAcceptedMessage = { message: 'If this address needs verification, a link has been sent.' };
const linkInvalidBody = { code: 'link_invalid', message: 'This link is invalid, expired, or already used.' };
const emailAlreadyRegisteredBody = {
    code: 'email_already_registered',
    message: 'This email already has an account. Log in or reset your password.'
};
const emailDomainUndeliverableBody = {
    code: 'email_domain_undeliverable',
    message: 'This email domain cannot receive email. Check the address and try again.'
};
const retiredRegistrationBody = {
    code: 'email_registration_moved',
    message: 'Email sign-up has moved to the Finitude website. Create your account there, then sign in.'
};
const maximumDisplayNameLength = 80;

const rejectInvalidRequest = (req: Request, res: Response) => {
    if (validationResult(req).isEmpty()) {
        return false;
    }
    res.status(422).json({ message: 'Please check the submitted fields.' });
    return true;
};

/**
 * Rejects a registration, verification-link or password-recovery request with
 * `422 email_domain_undeliverable` when the submitted address's domain cannot
 * receive mail (NXDOMAIN, no MX, only a null MX, or not a valid hostname), so
 * the listener can correct a mistyped address instead of waiting for an email
 * that will never arrive.
 *
 * The verdict comes only from public DNS for the domain and runs before any
 * account lookup, so neither the answer nor its latency can depend on whether
 * the address has an account. Mount it after the route's per-IP limit and
 * email validation, and before the per-address limit: a rejected request
 * counts toward the client's per-IP budget but spends neither the address's
 * attempt budget nor its link-email budget, and sends or prepares nothing.
 * A deliverable or unknown verdict (a DNS failure) passes the request on
 * unchanged; the verdict is cached, so the later `sendAuthEmail` check, kept
 * as defense in depth, normally reuses it. Invalid input is left to the
 * controller's generic validation answer without a lookup.
 */
export const rejectUndeliverableEmailDomain = (req: Request, res: Response, next: NextFunction) =>
    runRequestWork(req, async () => {
        if (!validationResult(req).isEmpty()) return next();
        const verdict = await checkEmailDomainDeliverability(normalizeEmail(req.body?.email));
        if (verdict.status !== 'undeliverable') return next();
        recordSecurityEvent('auth_email_domain_rejected', { domain: verdict.domain ?? undefined, reason: verdict.reason });
        return res.status(422).json(emailDomainUndeliverableBody);
    }).catch(next);

/**
 * Sends a generic response before running per-account email work.
 *
 * The lookup, token write, password hash, recipient-domain DNS check, and SES
 * send take measurably longer for some account states, so awaiting them first
 * would let response latency reveal whether an email has an account. (Request
 * routes have already passed `rejectUndeliverableEmailDomain`, whose latency
 * depends only on the domain.) The work stays inside the caller's handler
 * promise (never detached), so `asyncHandler` keeps tracking it: graceful
 * shutdown waits for it to finish, and so do concurrency limits.
 * Failures are recorded only as an opaque security event, because the
 * response has already been sent.
 */
export const respondBeforeAccountWork = async (
    respond: () => void,
    event: string,
    operation: () => Promise<void>
) => {
    respond();
    try {
        await operation();
    } catch {
        recordSecurityEvent(event);
    }
};

/**
 * Finishes email requests uniformly so neither latency nor delivery failures
 * enumerate accounts. `requireConfiguration` runs first: configuration errors
 * are deployment-wide and safe to report before any account lookup, while
 * per-account persistence and delivery failures stay opaque.
 */
export const acceptEmailRequest = async (
    res: Response,
    accepted: { message: string },
    requireConfiguration: () => unknown,
    event: string,
    operation: () => Promise<void>
) => {
    requireConfiguration();
    await respondBeforeAccountWork(() => res.status(202).json(accepted), event, operation);
};

/**
 * Answers a sign-in that presented a valid credential for an unverified
 * account with the distinct verification-required `403`, then mails the
 * verification or registration link inside the tracked request work. The body
 * is identical whether or not an email goes out.
 */
export const respondEmailVerificationRequired = (
    res: Response,
    account: EmailVerificationSubject,
    method: AuthenticationMethod
) => {
    recordSecurityEvent('login_verification_required', { userId: account._id.toString() });
    recordAuthFunnelEvent('login', method, 'rejected');
    return respondBeforeAccountWork(
        () => res.status(403).json({ code: 'email_verification_required', message: signInVerificationRequiredMessage }),
        'auth_link_email_failed',
        () => sendSignInVerificationEmail(account)
    );
};

/** Answers the retired code-based registration endpoints without validation, limits or account work. */
export const retiredRegistrationEndpoint = (_req: Request, res: Response) => {
    recordSecurityEvent('retired_registration_endpoint');
    return res.status(410).json(retiredRegistrationBody);
};

/**
 * Starts Web registration with only an email address. Every account state
 * receives the same response before any account work. An address without an
 * account, or with an unverified record from the earlier code-based sign-up,
 * receives a registration link; an address with an account receives the
 * "already registered" notice and nothing changes. Legacy owners reach
 * verification through password reset. An address whose domain cannot
 * receive mail was already rejected by `rejectUndeliverableEmailDomain`.
 */
export const requestRegistration = async (req: Request, res: Response) => {
    if (rejectInvalidRequest(req, res)) return;
    const email = normalizeEmail(req.body.email);
    return acceptEmailRequest(
        res,
        registrationAcceptedMessage,
        requireAuthLinkConfiguration,
        'email_registration_request_failed',
        async () => {
            const user = await User.findByEmail(email);
            if (!user || user.emailVerified === false) await sendRegistrationLink(email);
            else await sendAlreadyRegisteredNotice(email);
        }
    );
};

/** Reports the address a registration link is for without consuming it. */
export const inspectRegistration = async (req: Request, res: Response) => {
    const token = req.body?.token;
    const link = isEmailLinkTokenFormat(token) ? await EmailLinkToken.findLive('registration', token) : null;
    if (!link) return res.status(400).json(linkInvalidBody);
    const user = await User.findByEmail(link.email);
    if (user && user.emailVerified !== false) return res.status(409).json(emailAlreadyRegisteredBody);
    return res.status(200).json({ email: link.email });
};

/** Trims a display name and accepts 1 to 80 characters without control characters. */
const acceptableDisplayName = (value: unknown) => {
    const displayName = typeof value === 'string' ? value.trim() : '';
    return displayName.length >= 1
        && displayName.length <= maximumDisplayNameLength
        && !/[\u0000-\u001f\u007f]/.test(displayName)
        ? displayName
        : null;
};

/**
 * Creates a verified account from a registration link, with the display name
 * and password chosen on the link page, or completely replaces the address's
 * unverified record. The user then logs in; no session is created here.
 */
export const completeRegistration = async (req: Request, res: Response) => {
    requireAuthLinkConfiguration();
    const token = req.body?.token;
    if (!isEmailLinkTokenFormat(token)) return res.status(400).json(linkInvalidBody);
    const password = req.body?.password;
    const policy = evaluatePassword(password);
    if (!policy.accepted) return res.status(422).json({ code: 'invalid_password', message: policy.message });
    const displayName = acceptableDisplayName(req.body?.displayName);
    if (!displayName) {
        return res.status(422).json({
            code: 'invalid_display_name',
            message: `Enter a display name between 1 and ${maximumDisplayNameLength} characters.`
        });
    }
    // Hash before any lookup: a hashing failure consumes nothing.
    const passwordHash = await bcrypt.hash(password as string, 12);
    const completion = await completeEmailRegistration(token, passwordHash, displayName);
    if (completion.status === 'invalid') return res.status(400).json(linkInvalidBody);
    if (completion.status === 'exists') return res.status(409).json(emailAlreadyRegisteredBody);
    recordSecurityEvent(
        completion.status === 'created' ? 'email_registration_completed' : 'email_registration_replaced_pending',
        { userId: completion.userId }
    );
    recordAuthFunnelEvent('registration', 'email', 'succeeded');
    return res.status(201).json({ email: completion.email });
};

/**
 * Sends a new verification link to an account created before verification
 * existed. Every other state does nothing, and every state receives the same
 * response before any account work. An address whose domain cannot receive
 * mail was already rejected by `rejectUndeliverableEmailDomain`.
 */
export const requestEmailVerification = async (req: Request, res: Response) => {
    if (rejectInvalidRequest(req, res)) return;
    const email = normalizeEmail(req.body.email);
    return acceptEmailRequest(
        res,
        verificationAcceptedMessage,
        requireAuthLinkConfiguration,
        'verification_link_request_failed',
        async () => {
            const user = await User.findByEmail(email);
            if (user && await emailVerificationState(user) === 'legacy_unverified') {
                await sendVerificationLink(normalizeEmail(user.email), user._id.toString());
            }
        }
    );
};

/** Reports the address a verification link would verify without consuming it. */
export const inspectEmailVerification = async (req: Request, res: Response) => {
    const token = req.body?.token;
    const email = isEmailLinkTokenFormat(token) ? await inspectEmailVerificationLink(token) : null;
    if (!email) return res.status(400).json(linkInvalidBody);
    return res.status(200).json({ email });
};

/**
 * Verifies a legacy account's email after an explicit confirmation, so link
 * scanners that only fetch the page cannot verify it. The password does not
 * change and other sessions stay signed in.
 */
export const confirmEmailVerification = async (req: Request, res: Response) => {
    const token = req.body?.token;
    const userId = isEmailLinkTokenFormat(token) ? await confirmEmailVerificationLink(token) : null;
    if (!userId) return res.status(400).json(linkInvalidBody);
    recordSecurityEvent('email_verified', { userId });
    recordAuthFunnelEvent('verification', 'email', 'succeeded');
    return res.status(204).send();
};

/**
 * Starts password recovery without revealing account existence. A record from
 * the earlier code-based sign-up receives a registration link instead of a
 * reset code, so whoever set its password never gains the account. An address
 * whose domain cannot receive mail was already rejected by
 * `rejectUndeliverableEmailDomain`.
 */
export const forgotPassword = async (req: Request, res: Response) => {
    if (rejectInvalidRequest(req, res)) return;
    return acceptEmailRequest(
        res,
        recoveryAcceptedMessage,
        requireAuthEmailConfiguration,
        'password_recovery_request_failed',
        async () => {
            const user = await User.findByEmail(normalizeEmail(req.body.email));
            if (!user) return;
            if (user.emailVerified === false) {
                try {
                    await sendRegistrationLink(normalizeEmail(user.email));
                } catch {
                    recordSecurityEvent('auth_link_email_failed');
                }
                return;
            }
            // The code is issued only once the domain can receive it, so a request for an
            // undeliverable address never replaces a code the owner already holds.
            await sendAuthEmail(user.email, 'resetCode', async () => ({
                template: 'resetCode',
                code: await AuthActionToken.issue(user._id.toString(), 'resetPassword', 15)
            }));
        }
    );
};

/**
 * Replaces a password after consuming a reset code, revokes every active
 * session and verifies the email, because the reset proves inbox control.
 */
export const resetPassword = async (req: Request, res: Response) => {
    if (rejectInvalidRequest(req, res)) return;
    // Hash before account/code resolution to keep invalid attempts on the same
    // expensive path and avoid consuming a valid code if hashing fails.
    const passwordHash = await bcrypt.hash(String(req.body.password), 12);
    const user = await User.findByEmail(normalizeEmail(req.body.email));
    const code = String(req.body.code ?? '').trim();
    if (!user || !await applyPasswordReset(user._id.toString(), code, passwordHash)) {
        return res.status(400).json({ message: 'The reset code is invalid or expired.' });
    }
    recordSecurityEvent('password_reset_completed', { userId: user._id.toString() });
    recordAuthFunnelEvent('recovery', 'password', 'succeeded');
    return res.status(204).send();
};
