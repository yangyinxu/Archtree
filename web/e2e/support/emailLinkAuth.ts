import { randomBytes } from 'node:crypto';

import type { Page, Request, Route } from '@playwright/test';

import type { BrowserSession } from '../../src/api/schemas';
import { installNonSocialProfileRoute } from './apiRoutes';

/** One plain-text email the fake mailer "sent", with the server's subject and body copy. */
export interface CapturedEmail {
  to: string;
  subject: string;
  text: string;
}

type AccountState = 'verified' | 'legacy_unverified' | 'pending_record';
type LinkPurpose = 'registration' | 'verifyEmail';

interface FakeAccount {
  session: BrowserSession;
  password: string;
  state: AccountState;
}

interface FakeLink {
  purpose: LinkPurpose;
  email: string;
  expiresAt: number;
  consumedAt?: number;
}

interface RecordedAccountRequest {
  path: string;
  body: unknown;
}

export interface EmailLinkAuthFixture {
  /** Every email the fake server sent, oldest first. */
  outbox: CapturedEmail[];
  /** Account-link requests in arrival order (bodies included; tests assert their exact fields). */
  requests: RecordedAccountRequest[];
  /** Contract violations seen by the fake server (wrong headers, extra fields, tokens in URLs). */
  violations: string[];
  /** Every request URL the page issued, to prove link tokens never leave the fragment. */
  requestUrls: string[];
  addAccount: (account: { session: BrowserSession; password: string; state: AccountState }) => void;
  /** Moves every issued link past its 30-minute lifetime. */
  expireLinks: () => void;
  /** Returns the newest link of a purpose mailed to an address, parsed exactly as server tests do. */
  latestLink: (to: string, purpose: LinkPurpose) => string;
  accountState: (email: string) => AccountState | undefined;
}

const linkLifetimeMilliseconds = 30 * 60 * 1000;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const linkInEmail = /(https?:\/\/[^\s#]+#token=([A-Za-z0-9_-]{43}))/;
const generic = {
  registration: { message: 'Check your email for the next step.' },
  verification: { message: 'If this address needs verification, a link has been sent.' },
  linkInvalid: { code: 'link_invalid', message: 'This link is invalid, expired, or already used.' },
  alreadyRegistered: {
    code: 'email_already_registered',
    message: 'This email already has an account. Log in or reset your password.'
  },
  verificationRequired: {
    code: 'email_verification_required',
    message: 'Verify your email to sign in. Open the verification link we sent to your email address, then sign in again.'
  }
};

const json = (route: Route, status: number, payload?: unknown, headers: Record<string, string> = {}) => route.fulfill({
  status,
  contentType: 'application/json; charset=utf-8',
  headers: { 'Cache-Control': 'no-store', ...headers },
  body: payload === undefined ? '' : JSON.stringify(payload)
});

/**
 * Installs a deterministic stand-in for Archtree's email-link account routes
 * with an in-memory mailbox. It follows the round-3 HTTP contract (generic
 * responses, single-use 30-minute links, non-consuming inspection, typed
 * errors) and the server's email copy, so the production bundle can be driven
 * through the whole "open the emailed link" journey without SES or MongoDB.
 * Install it after any broader route helpers: later Playwright routes win.
 */
export const installEmailLinkAuth = async (
  page: Page,
  origin: string,
  /** The id a newly registered account receives, so owner-scoped fixtures can serve it after login. */
  newAccountId = 'e2e-email-link-listener'
): Promise<EmailLinkAuthFixture> => {
  const accounts = new Map<string, FakeAccount>();
  const links = new Map<string, FakeLink>();
  const outbox: CapturedEmail[] = [];
  const requests: RecordedAccountRequest[] = [];
  const violations: string[] = [];
  const requestUrls: string[] = [];
  let signedInViewer: string | null = null;

  page.on('request', (request) => requestUrls.push(request.url()));

  const issueLink = (purpose: LinkPurpose, email: string) => {
    const token = randomBytes(32).toString('base64url');
    links.set(token, { purpose, email, expiresAt: Date.now() + linkLifetimeMilliseconds });
    return token;
  };
  const liveLink = (purpose: LinkPurpose, token: unknown) => {
    if (typeof token !== 'string' || !tokenPattern.test(token)) return null;
    const link = links.get(token);
    return link && link.purpose === purpose && !link.consumedAt && link.expiresAt > Date.now() ? link : null;
  };
  const sendRegistrationLink = (email: string) => {
    const token = issueLink('registration', email);
    outbox.push({
      to: email,
      subject: 'Finish creating your Finitude account',
      text: [
        'Someone asked to create a Finitude account with this email address.',
        '',
        'To choose your display name and password, open this link within 30 minutes:',
        `${origin}/finitude/register/complete#token=${token}`,
        '',
        'The link works once. If you didn\'t ask for this, ignore this email and no account will be created.'
      ].join('\n')
    });
  };
  const sendAlreadyRegistered = (email: string) => outbox.push({
    to: email,
    subject: 'You already have a Finitude account',
    text: [
      'Someone asked to create a Finitude account with this email address, but it already has one. Nothing was changed.',
      '',
      'Log in on the web or in the Finitude app:',
      `${origin}/finitude/login`,
      '',
      'Forgot your password? Reset it here:',
      `${origin}/finitude/forgot-password`,
      '',
      'If you didn\'t ask for this, you can ignore this email.'
    ].join('\n')
  });
  const sendVerificationLink = (email: string) => {
    const token = issueLink('verifyEmail', email);
    outbox.push({
      to: email,
      subject: 'Verify your Finitude email',
      text: [
        'Your Finitude account needs a verified email address before you can sign in again.',
        '',
        'If you just tried to sign in or asked for this link, open it within 30 minutes and select Verify email, then sign in again:',
        `${origin}/finitude/verify-email#token=${token}`,
        '',
        'Your password doesn\'t change. If you didn\'t just try to sign in, don\'t open the link. Reset your password instead:',
        `${origin}/finitude/forgot-password`
      ].join('\n')
    });
  };
  const consumeSiblings = (purpose: LinkPurpose, email: string) => {
    for (const link of links.values()) {
      if (link.purpose === purpose && link.email === email) link.consumedAt = Date.now();
    }
  };

  /** Applies the same-origin JSON rules every new browser account route enforces. */
  const readBody = (request: Request, fields: string[]) => {
    const url = new URL(request.url());
    const path = url.pathname;
    if (request.method() !== 'POST') violations.push(`${path}: method ${request.method()}`);
    if (url.search) violations.push(`${path}: unexpected query string`);
    if (!request.headers()['content-type']?.startsWith('application/json')) violations.push(`${path}: not JSON`);
    if (request.headers().origin !== origin) violations.push(`${path}: origin ${request.headers().origin}`);
    const body = request.postDataJSON() as Record<string, unknown> | null;
    const keys = Object.keys(body ?? {}).sort();
    if (keys.join(',') !== [...fields].sort().join(',')) violations.push(`${path}: fields ${keys.join(',')}`);
    requests.push({ path, body });
    return body ?? {};
  };

  await installNonSocialProfileRoute(page, () => signedInViewer);
  await page.route('**/auth/browser/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;

    if (path === '/auth/browser/session' && request.method() === 'GET') {
      const account = [...accounts.values()].find(({ session }) => session.user.id === signedInViewer);
      return account ? json(route, 200, account.session) : json(route, 401, { message: 'Unauthorized' });
    }
    if (path === '/auth/browser/registration/request') {
      const { email } = readBody(request, ['email']);
      const address = String(email).toLowerCase();
      const account = accounts.get(address);
      if (!account || account.state === 'pending_record') sendRegistrationLink(address);
      else sendAlreadyRegistered(address);
      return json(route, 202, generic.registration);
    }
    if (path === '/auth/browser/registration/inspect') {
      const { token } = readBody(request, ['token']);
      const link = liveLink('registration', token);
      if (!link) return json(route, 400, generic.linkInvalid);
      const account = accounts.get(link.email);
      if (account && account.state !== 'pending_record') return json(route, 409, generic.alreadyRegistered);
      return json(route, 200, { email: link.email });
    }
    if (path === '/auth/browser/registration/complete') {
      const { token, password, displayName } = readBody(request, ['token', 'password', 'displayName']);
      const link = liveLink('registration', token);
      if (!link) return json(route, 400, generic.linkInvalid);
      if (typeof password !== 'string' || password.length < 12 || password.length > 256) {
        return json(route, 422, { code: 'invalid_password', message: 'Choose a different password.' });
      }
      const name = typeof displayName === 'string' ? displayName.trim() : '';
      if (!name || name.length > 80) {
        return json(route, 422, { code: 'invalid_display_name', message: 'Enter a display name between 1 and 80 characters.' });
      }
      link.consumedAt = Date.now();
      const existing = accounts.get(link.email);
      if (existing && existing.state !== 'pending_record') return json(route, 409, generic.alreadyRegistered);
      consumeSiblings('registration', link.email);
      accounts.set(link.email, {
        password,
        state: 'verified',
        session: {
          user: {
            id: existing?.session.user.id ?? newAccountId,
            email: link.email,
            role: 'user',
            displayName: name,
            avatarRevision: 0,
            avatar: null,
            emailVerified: true,
            authenticationMethods: ['password']
          }
        }
      });
      return json(route, 201, { email: link.email });
    }
    if (path === '/auth/browser/email-verification/request') {
      const { email } = readBody(request, ['email']);
      const address = String(email).toLowerCase();
      if (accounts.get(address)?.state === 'legacy_unverified') sendVerificationLink(address);
      return json(route, 202, generic.verification);
    }
    if (path === '/auth/browser/email-verification/inspect') {
      const { token } = readBody(request, ['token']);
      const link = liveLink('verifyEmail', token);
      const account = link && accounts.get(link.email);
      if (!link || !account || account.state === 'pending_record') return json(route, 400, generic.linkInvalid);
      return json(route, 200, { email: link.email });
    }
    if (path === '/auth/browser/email-verification/confirm') {
      const { token } = readBody(request, ['token']);
      const link = liveLink('verifyEmail', token);
      const account = link && accounts.get(link.email);
      if (!link || !account || account.state === 'pending_record') return json(route, 400, generic.linkInvalid);
      consumeSiblings('verifyEmail', link.email);
      account.state = 'verified';
      account.session = { user: { ...account.session.user, emailVerified: true } };
      return json(route, 204);
    }
    if (path === '/auth/browser/login' && request.method() === 'POST') {
      if (request.headers()['x-finitude-session-transition'] !== 'web-locks-v1') {
        violations.push('/auth/browser/login: missing session transition');
      }
      const { identifier, password } = request.postDataJSON() as { identifier?: string; password?: string };
      const account = accounts.get(String(identifier).trim().toLowerCase());
      if (!account || account.password !== password) return json(route, 401, { message: 'Invalid credentials.' });
      if (account.state !== 'verified') {
        // Mirrors the server: the 403 goes out first, then the mailer runs.
        await json(route, 403, generic.verificationRequired);
        if (account.state === 'legacy_unverified') sendVerificationLink(account.session.user.email);
        else sendRegistrationLink(account.session.user.email);
        return;
      }
      signedInViewer = account.session.user.id;
      return json(route, 200, account.session, { 'X-Finitude-Account-Viewer': signedInViewer });
    }
    return route.fallback();
  });

  return {
    outbox,
    requests,
    violations,
    requestUrls,
    addAccount: ({ session, password, state }) => {
      accounts.set(session.user.email.toLowerCase(), { session, password, state });
    },
    expireLinks: () => {
      for (const link of links.values()) link.expiresAt = Date.now() - 1;
    },
    latestLink: (to, purpose) => {
      const path = purpose === 'registration' ? '/finitude/register/complete#' : '/finitude/verify-email#';
      const email = [...outbox].reverse().find((candidate) => candidate.to === to && candidate.text.includes(path));
      const match = email ? linkInEmail.exec(email.text) : null;
      if (!match) throw new Error(`No ${purpose} link was mailed to ${to}.`);
      return match[1];
    },
    accountState: (email) => accounts.get(email.toLowerCase())?.state
  };
};
