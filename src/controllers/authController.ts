import { Request, Response, NextFunction } from 'express';
import { validationResult } from 'express-validator';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import User from '../models/user';
import AuthSession from '../models/authSession';
import {
  AccessTokenPayload,
  createSession,
  createLegacyMigrationToken,
  getJwtSecret,
  refreshSession,
  refreshSessionIdentity,
  revokeRefreshSession,
  SessionUser
} from '../services/authSessionService';
import {
  clearBrowserSessionCookies,
  getCookieValue,
  setBrowserSessionCookies,
  setBrowserSessionPrivacyHeaders
} from '../services/authCookieService';
import { recordAuthFunnelEvent, recordSecurityEvent } from '../services/securityAuditService';
import AuthIdentity from '../models/authIdentity';
import { Passkey } from '../models/passkey';
import { registerEmailAccount } from './emailAuthController';
import { normalizeUserRole } from '../services/authRoleService';

/**
 * Interface for Error object with statusCode property
 */
interface ErrorWithStatusCode extends Error {
  statusCode?: number;
  data?: any;
}

export interface BrowserSessionUserSource {
  userId: string;
  email: string;
  role?: unknown;
  displayName?: string;
  username?: string;
  avatarAssetId?: unknown;
  avatarRevision?: number;
  emailVerified?: boolean;
  authenticationMethods?: BrowserAuthenticationMethod[];
}

export type BrowserAuthenticationMethod = 'password' | 'apple' | 'google' | 'passkey';

/** Projects account identity while deliberately omitting credentials and session identifiers. */
export const browserSessionPayload = (source: BrowserSessionUserSource) => {
  const avatarRevision = Number(source.avatarRevision ?? 0);
  return {
    user: {
      id: source.userId,
      email: source.email,
      role: normalizeUserRole(source.role),
      displayName: source.displayName ?? source.username ?? '',
      avatarRevision,
      avatar: source.avatarAssetId ? { revision: avatarRevision } : null,
      emailVerified: source.emailVerified !== false,
      ...(source.authenticationMethods
        ? { authenticationMethods: source.authenticationMethods }
        : {})
    }
  };
};

const normalizeEmail = (email: string) => {
  return String(email ?? '').trim().toLowerCase();
};

const normalizeIdentifier = (value: string) => {
  return String(value ?? '').trim();
};

/** Restricts legacy form redirects to known same-origin browser destinations. */
export const safeWebReturnTo = (value: unknown) => {
  const candidate = String(value ?? '').trim();
  if (!candidate.startsWith('/') || candidate.startsWith('//')) return '/';
  try {
    const base = 'https://archtree.invalid';
    const destination = new URL(candidate, base);
    if (destination.origin !== base) return '/';
    const contentManagerDestination = [
      '/content/manage',
      '/content/manage/audio-tracks',
      '/content/manage/search'
    ].includes(destination.pathname);
    const listenerDestination = destination.pathname === '/finitude'
      || destination.pathname.startsWith('/finitude/');
    const legacyListenerDestination = destination.pathname === '/listen'
      || destination.pathname.startsWith('/listen/');
    if (!contentManagerDestination
      && !listenerDestination
      && !legacyListenerDestination
      && destination.pathname !== '/') {
      return '/';
    }
    const pathname = legacyListenerDestination
      ? destination.pathname.replace(/^\/listen(?=\/|$)/, '/finitude')
      : destination.pathname;
    return `${pathname}${destination.search}${destination.hash}`;
  } catch {
    return '/';
  }
};

const escapeHtml = (value: string) => {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
};

const renderSignupHtml = (params: {
  email?: string;
  username?: string;
  errorMessage?: string;
  successMessage?: string;
}) => {
  const email = escapeHtml(params.email ?? '');
  const username = escapeHtml(params.username ?? '');
  const errorMessage = params.errorMessage ? `<div class="alert alert--error" role="alert">${escapeHtml(params.errorMessage)}</div>` : '';
  const successMessage = params.successMessage ? `<div class="alert" role="status">${escapeHtml(params.successMessage)}</div>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Archtree Sign Up</title>
  <link rel="stylesheet" href="/assets/archtree.css" />
</head>
<body>
  <main class="page-shell page-shell--narrow auth-card">
    <a class="brand" href="/">
      <span class="brand-mark" aria-hidden="true">A</span>
      <span>Archtree</span>
    </a>
    <section class="card card--raised">
      <p class="eyebrow">New workspace</p>
      <h1>Create your account</h1>
      <p class="muted">Start organizing your music catalog and publishing structure.</p>
      ${errorMessage}
      ${successMessage}
      <form method="POST" action="/auth/signup-web">
        <label for="signup-email">Email</label>
        <input id="signup-email" type="email" name="email" value="${email}" autocomplete="email" required />
        <label for="signup-username">Username</label>
        <input id="signup-username" type="text" name="username" value="${username}" autocomplete="username" required />
        <label for="signup-password">Password</label>
        <input id="signup-password" type="password" name="password" minlength="12" autocomplete="new-password" required />
        <span class="muted">Use at least 12 characters.</span>
        <button type="submit">Create account</button>
      </form>
    </section>
    <p class="auth-footer">Already have an account? <a href="/auth/login-web">Log in</a></p>
  </main>
</body>
</html>`;
};

const renderLoginHtml = (params: {
  identifier?: string;
  returnTo?: string;
  errorMessage?: string;
  successMessage?: string;
  token?: string;
  userId?: string;
}) => {
  const identifier = escapeHtml(params.identifier ?? '');
  const errorMessage = params.errorMessage ? `<div class="alert alert--error" role="alert">${escapeHtml(params.errorMessage)}</div>` : '';
  const successMessage = params.successMessage ? `<div class="alert" role="status">${escapeHtml(params.successMessage)}</div>` : '';
  const token = params.token ? `<pre class="card" style="white-space:pre-wrap;word-break:break-word;">${escapeHtml(params.token)}</pre>` : '';
  const userId = params.userId ? `<p><strong>User ID:</strong> ${escapeHtml(params.userId)}</p>` : '';
  const returnTo = escapeHtml(params.returnTo ?? '/');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Archtree Login</title>
  <link rel="stylesheet" href="/assets/archtree.css" />
</head>
<body>
  <main class="page-shell page-shell--narrow auth-card">
    <a class="brand" href="/">
      <span class="brand-mark" aria-hidden="true">A</span>
      <span>Archtree</span>
    </a>
    <section class="card card--raised">
      <p class="eyebrow">Welcome back</p>
      <h1>Log in to Archtree</h1>
      <p class="muted">Continue managing your catalog and listening experience.</p>
      ${errorMessage}
      ${successMessage}
      ${userId}
      ${token}
      <form method="POST" action="/auth/login-web">
        <input type="hidden" name="returnTo" value="${returnTo}" />
        <label for="login-identifier">Email or username</label>
        <input id="login-identifier" type="text" name="identifier" value="${identifier}" autocomplete="username" required />
        <label for="login-password">Password</label>
        <input id="login-password" type="password" name="password" autocomplete="current-password" required />
        <button type="submit">Log in</button>
      </form>
    </section>
    <p class="auth-footer">Need an account? <a href="/auth/signup-web">Create one</a></p>
  </main>
</body>
</html>`;
};

// A fixed-cost comparison prevents missing accounts from returning materially faster.
const dummyPasswordHash = bcrypt.hashSync('archtree-invalid-password', 12);

/** Validates credentials without revealing whether the identifier exists. */
const authenticateUser = async (identifier: string, password: string, req?: Request) => {
  if (!identifier || identifier.length > 254 || typeof password !== 'string' || password.length > 256) {
    const error: ErrorWithStatusCode = new Error('Invalid credentials.');
    error.statusCode = 401;
    throw error;
  }
  const user = await User.findByIdentifier(identifier);
  if (!user) {
    await bcrypt.compare(password, dummyPasswordHash);
    const error: ErrorWithStatusCode = new Error('Invalid credentials.');
    error.statusCode = 401;
    throw error;
  }

  const isEqual = await bcrypt.compare(password, user.password);
  if (!isEqual) {
    const error: ErrorWithStatusCode = new Error('Invalid credentials.');
    error.statusCode = 401;
    throw error;
  }
  if (user.emailVerified === false) {
    const error: ErrorWithStatusCode = new Error('Verify your email before signing in.');
    error.statusCode = 403;
    throw error;
  }

  return {
    userId: user._id.toString(),
    email: user.email,
    role: normalizeUserRole(user.role),
    displayName: user.displayName ?? user.username ?? '',
    username: user.username ?? '',
    avatarAssetId: user.avatarAssetId,
    avatarRevision: Number(user.avatarRevision ?? 0),
    emailVerified: user.emailVerified !== false,
    legacyToken: createLegacyMigrationToken(user as unknown as SessionUser),
    ...(await createSession(user as unknown as SessionUser, req))
  };
};

/** Loads the authoritative safe listener identity after cookie authentication. */
const loadBrowserSessionPayload = async (userId: string) => {
  const user = await User.findById(userId);
  if (!user) {
    const error: ErrorWithStatusCode = new Error('Authentication failed.');
    error.statusCode = 401;
    throw error;
  }
  const [identities, passkeys] = await Promise.all([
    AuthIdentity.listForUser(userId),
    Passkey.listForUser(userId)
  ]);
  const availableMethods = new Set<BrowserAuthenticationMethod>();
  if (user.password) availableMethods.add('password');
  identities.forEach(({ provider }) => availableMethods.add(provider));
  if (passkeys.length > 0) availableMethods.add('passkey');
  const authenticationMethods = (
    ['password', 'apple', 'google', 'passkey'] as BrowserAuthenticationMethod[]
  ).filter((method) => availableMethods.has(method));
  return browserSessionPayload({
    userId: user._id.toString(),
    email: user.email,
    role: normalizeUserRole(user.role),
    displayName: user.displayName ?? user.username ?? '',
    username: user.username ?? '',
    avatarAssetId: user.avatarAssetId,
    avatarRevision: Number(user.avatarRevision ?? 0),
    emailVerified: user.emailVerified !== false,
    authenticationMethods
  });
};

/** Recovers only a signed identity so browser transitions can fence an expired access token. */
const browserAccessSessionIdentity = (req: Request) => {
  const accessToken = getCookieValue(req, 'session_token');
  if (!accessToken) return null;
  try {
    const claims = jwt.verify(accessToken, getJwtSecret(), {
      ignoreExpiration: true
    }) as Partial<AccessTokenPayload>;
    if (
      claims.tokenType !== 'access'
      || typeof claims.userId !== 'string'
      || typeof claims.sessionId !== 'string'
    ) {
      return null;
    }
    return { userId: claims.userId, sessionId: claims.sessionId };
  } catch {
    return null;
  }
};

/** Revokes stable identities plus rotating credentials so logout wins refresh races. */
const revokeBrowserRequestSession = async (
  req: Request,
  knownIdentities: Array<{ userId: string; sessionId: string }> = []
) => {
  const identities = [browserAccessSessionIdentity(req), ...knownIdentities]
    .filter((identity): identity is { userId: string; sessionId: string } => Boolean(identity));
  const refreshToken = getCookieValue(req, 'refresh_token');
  const revocations: Promise<unknown>[] = [];
  const seenSessionIds = new Set<string>();
  for (const identity of identities) {
    if (seenSessionIds.has(identity.sessionId)) continue;
    seenSessionIds.add(identity.sessionId);
    revocations.push(AuthSession.revokeById(identity.userId, identity.sessionId));
  }
  if (refreshToken) {
    revocations.push(revokeRefreshSession(refreshToken));
  }
  const results = await Promise.allSettled(revocations);
  const failed = results.find((result) => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
};

/** Revokes the request's previous browser identity before new cookies can be committed. */
const revokePreviousBrowserSessionForLogin = async (
  req: Request,
  createdSession: { userId: string; sessionId: string }
) => {
  try {
    await revokeBrowserRequestSession(req);
  } catch (error) {
    // Credential replacement is fail-closed: a newly-created session must not
    // survive when the request's prior browser session could not be revoked.
    await AuthSession.revokeById(createdSession.userId, createdSession.sessionId).catch(() => {
      recordSecurityEvent('browser_login_cleanup_failed', {
        userId: createdSession.userId,
        sessionId: createdSession.sessionId
      });
    });
    throw error;
  }
};

export const renderSignupPage = (req: Request, res: Response) => {
  res.status(200).send(renderSignupHtml({}));
};

export const renderLoginPage = (req: Request, res: Response) => {
  const returnTo = safeWebReturnTo(req.query.returnTo);
  res.redirect(303, `/finitude/login?returnTo=${encodeURIComponent(returnTo)}`);
};

export const signupFromWeb = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const errors = validationResult(req);
    const email = normalizeEmail(req.body.email);
    const username = req.body.username;
    const password = req.body.password;

    if (!errors.isEmpty()) {
      const firstError = errors.array()[0]?.msg ?? 'Validation failed.';
      res.status(422).send(renderSignupHtml({
        email,
        username,
        errorMessage: String(firstError)
      }));
      return;
    }

    try {
      await registerEmailAccount(email, password, username, username);
    } catch {
      recordSecurityEvent('email_registration_request_failed');
    }
    return res.status(202).send(renderSignupHtml({
      successMessage: 'If the account can be created, a verification code has been sent. Verify the email before logging in.'
    }));
  } catch (error: any) {
    next(error);
  }
};

export const login = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const identifier: string = normalizeIdentifier(req.body.identifier ?? req.body.email ?? req.body.username);
    const password: string = req.body.password;
    const authResult = await authenticateUser(identifier, password, req);
    recordSecurityEvent('login_succeeded', {
      userId: authResult.userId,
      sessionId: authResult.sessionId
    });
    recordAuthFunnelEvent('login', 'password', 'succeeded');

    res.status(200).json({
      // Old clients read `token`; opt-in migration mode can preserve their session lifetime.
      token: authResult.legacyToken ?? authResult.accessToken,
      accessToken: authResult.accessToken,
      refreshToken: authResult.refreshToken,
      accessTokenExpiresIn: authResult.accessTokenExpiresIn,
      refreshTokenExpiresAt: authResult.refreshTokenExpiresAt,
      userId: authResult.userId,
      email: authResult.email,
      role: authResult.role
    });
  } catch (error: any) {
    recordAuthFunnelEvent('login', 'password', 'rejected');
    if (!error.statusCode) {
      error.statusCode = 500;
    }
    next(error);
  }
};

export const loginFromWeb = async (req: Request, res: Response) => {
  const returnTo = safeWebReturnTo(req.body.returnTo);
  // Legacy HTML forms cannot prove ownership of the origin-wide Web Lock, so
  // they never install cookies. The listener SPA owns the coordinated login.
  recordSecurityEvent('browser_form_login_redirected');
  res.redirect(303, `/finitude/login?returnTo=${encodeURIComponent(returnTo)}`);
};

/** Establishes an HttpOnly listener session without exposing either credential. */
export const browserLogin = async (req: Request, res: Response, next: NextFunction) => {
  setBrowserSessionPrivacyHeaders(res);
  const identifier = normalizeIdentifier(req.body.identifier ?? req.body.email ?? req.body.username);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (!identifier || !password) {
    recordAuthFunnelEvent('login', 'password', 'rejected');
    return res.status(422).json({ message: 'Identifier and password are required.' });
  }

  let authResult: Awaited<ReturnType<typeof authenticateUser>> | undefined;
  let previousSessionRevoked = false;
  try {
    authResult = await authenticateUser(identifier, password, req);
    await revokePreviousBrowserSessionForLogin(req, authResult);
    previousSessionRevoked = true;
    const payload = await loadBrowserSessionPayload(authResult.userId);
    setBrowserSessionCookies(res, authResult);
    recordSecurityEvent('browser_json_login_succeeded', {
      userId: authResult.userId,
      sessionId: authResult.sessionId
    });
    recordAuthFunnelEvent('login', 'password', 'succeeded');
    return res.status(200).json(payload);
  } catch (error: any) {
    if (authResult) {
      await AuthSession.revokeById(authResult.userId, authResult.sessionId).catch(() => {
        recordSecurityEvent('browser_login_cleanup_failed', {
          userId: authResult?.userId,
          sessionId: authResult?.sessionId
        });
      });
      if (previousSessionRevoked) clearBrowserSessionCookies(res);
    }
    recordSecurityEvent('browser_json_login_rejected');
    recordAuthFunnelEvent('login', 'password', 'rejected');
    if (!error.statusCode) {
      error.statusCode = 500;
    }
    return next(error);
  }
};

/** Rotates the refresh cookie once and returns only safe account metadata. */
export const browserRefresh = async (req: Request, res: Response) => {
  setBrowserSessionPrivacyHeaders(res);
  const requestedViewer = String(req.get('X-Finitude-Account-Viewer') ?? '').trim();
  const refreshToken = getCookieValue(req, 'refresh_token');
  let refreshIdentity: Awaited<ReturnType<typeof refreshSessionIdentity>>;
  try {
    refreshIdentity = await refreshSessionIdentity(refreshToken);
  } catch {
    recordSecurityEvent('browser_json_refresh_identity_unavailable');
    return res.status(503).json({
      message: 'Finitude could not safely confirm the active account.'
    });
  }
  if (!refreshIdentity) {
    recordSecurityEvent('browser_json_refresh_rejected');
    return res.status(401).json({ message: 'Authentication failed.' });
  }

  // Recover even an expired or revoked signed access identity. Its account is
  // still a trustworthy fence against rotating a different account's refresh
  // credential after another tab has changed the shared cookie jar.
  const accessIdentity = browserAccessSessionIdentity(req);
  if (
    (requestedViewer && requestedViewer !== refreshIdentity.userId)
    || (accessIdentity && accessIdentity.userId !== refreshIdentity.userId)
  ) {
    recordSecurityEvent('browser_json_refresh_identity_conflict');
    return res.status(409).json({
      code: 'browser_session_identity_conflict',
      message: 'The browser session contains conflicting account credentials.'
    });
  }

  const tokens = await refreshSession(refreshToken);
  if (!tokens) {
    recordSecurityEvent('browser_json_refresh_rejected');
    return res.status(401).json({ message: 'Authentication failed.' });
  }

  // Commit the rotated pair before the profile read so a transient read failure does
  // not strand the browser with the refresh token that was just consumed.
  setBrowserSessionCookies(res, tokens);
  const claims = jwt.verify(tokens.accessToken, getJwtSecret()) as AccessTokenPayload;
  res.setHeader('X-Finitude-Account-Viewer', claims.userId);
  const payload = await loadBrowserSessionPayload(claims.userId);
  recordSecurityEvent('browser_json_refresh_succeeded', { sessionId: tokens.sessionId });
  return res.status(200).json(payload);
};

/** Returns the current cookie-authenticated listener identity. */
export const browserSession = async (req: Request, res: Response) => {
  setBrowserSessionPrivacyHeaders(res);
  const auth = (req as Request & { auth?: { userId: string } }).auth;
  if (!auth) {
    return res.status(401).json({ message: 'Missing or invalid browser session.' });
  }
  let refreshIdentity: Awaited<ReturnType<typeof refreshSessionIdentity>>;
  try {
    refreshIdentity = await refreshSessionIdentity(getCookieValue(req, 'refresh_token'));
  } catch {
    return res.status(503).json({ message: 'Finitude could not safely confirm the active account.' });
  }
  if (refreshIdentity && refreshIdentity.userId !== auth.userId) {
    recordSecurityEvent('browser_json_session_identity_conflict');
    return res.status(409).json({
      code: 'browser_session_identity_conflict',
      message: 'The browser session contains conflicting account credentials.'
    });
  }
  return res.status(200).json(await loadBrowserSessionPayload(auth.userId));
};

/** Revokes the refresh session and clears both cookies without a redirect. */
export const browserLogout = async (req: Request, res: Response) => {
  setBrowserSessionPrivacyHeaders(res);
  const canClearCookies = req.get('X-Finitude-Session-Transition') === 'web-locks-v1';
  const requestedViewer = String(req.get('X-Finitude-Account-Viewer') ?? '').trim();
  const accessIdentity = browserAccessSessionIdentity(req);
  let refreshIdentity: Awaited<ReturnType<typeof refreshSessionIdentity>>;
  try {
    refreshIdentity = await refreshSessionIdentity(getCookieValue(req, 'refresh_token'));
  } catch {
    // Account binding cannot safely guess through a database outage; fail closed
    // rather than clearing a newer account's cookies from a stale page.
    recordSecurityEvent('browser_json_logout_identity_unavailable');
    return res.status(503).json({ message: 'Finitude could not safely confirm the active account.' });
  }
  const credentialIdentities = [accessIdentity, refreshIdentity].filter(
    (identity): identity is NonNullable<typeof identity> => Boolean(identity)
  );
  const credentialViewers = new Set(credentialIdentities.map(({ userId }) => userId));
  if (credentialViewers.size > 1) {
    if (!canClearCookies) {
      return res.status(409).json({
        code: 'browser_session_identity_conflict',
        message: 'The browser session contains conflicting account credentials.'
      });
    }
    try {
      await revokeBrowserRequestSession(req, credentialIdentities);
    } catch {
      recordSecurityEvent('browser_json_logout_revocation_failed');
      return res.status(503).json({ message: 'Sign out could not be confirmed.' });
    }
    clearBrowserSessionCookies(res);
    recordSecurityEvent('browser_json_logout_identity_conflict_recovered');
    return res.status(204).send();
  }
  if (credentialIdentities.length > 0 && (
    !requestedViewer
    || credentialIdentities.some(({ userId }) => userId !== requestedViewer)
  )) {
    recordSecurityEvent('browser_json_logout_viewer_mismatch');
    return res.status(409).json({
      code: 'account_viewer_mismatch',
      message: 'The active account changed. Refresh the account before trying again.'
    });
  }
  try {
    await revokeBrowserRequestSession(req, credentialIdentities);
    recordSecurityEvent('browser_json_logout_completed');
  } catch {
    recordSecurityEvent('browser_json_logout_revocation_failed');
    return res.status(503).json({ message: 'Sign out could not be confirmed.' });
  }
  // Only a caller serialized by the origin-wide Web Lock may return a cookie-
  // clearing response; fallback clients are revoke-only so a late response
  // cannot erase credentials installed by a newer account transition.
  if (canClearCookies) clearBrowserSessionCookies(res);
  const responseViewer = credentialIdentities[0]?.userId ?? requestedViewer;
  if (responseViewer) res.setHeader('X-Finitude-Account-Viewer', responseViewer);
  return res.status(204).send();
};

/** Rotates an opaque refresh token and returns a new access/refresh pair. */
export const refresh = async (req: Request, res: Response) => {
  const refreshToken = String(req.body.refreshToken ?? '');
  const tokens = await refreshSession(refreshToken);
  if (!tokens) {
    recordSecurityEvent('refresh_rejected');
    return res.status(401).json({ message: 'Authentication failed.' });
  }

  recordSecurityEvent('refresh_succeeded', { sessionId: tokens.sessionId });
  return res.status(200).json(tokens);
};

/** Revokes one refresh session and always clears the client-side session. */
export const logout = async (req: Request, res: Response) => {
  await revokeRefreshSession(String(req.body.refreshToken ?? ''));
  recordSecurityEvent('logout_completed');
  return res.status(204).send();
};

/** Revokes every active session for the authenticated account. */
export const logoutAll = async (req: Request, res: Response) => {
  const userId = (req as Request & { auth?: { userId: string } }).auth?.userId;
  if (userId) {
    await AuthSession.revokeAll(userId);
    recordSecurityEvent('logout_all_completed', { userId });
  }
  return res.status(204).send();
};

/** Returns the authoritative identity for the current access token. */
export const me = async (req: Request, res: Response) => {
  const auth = (req as Request & { auth?: { userId: string; email: string; role: string } }).auth!;
  const user = await User.findById(auth.userId);
  const identities = await AuthIdentity.listForUser(auth.userId);
  const passkeys = await Passkey.listForUser(auth.userId);
  const authenticationMethods = [
    ...(user?.password ? ['password'] : []),
    ...identities.map(identity => identity.provider),
    ...(passkeys.length > 0 ? ['passkey'] : [])
  ];
  return res.status(200).json({
    ...auth,
    displayName: user?.displayName ?? user?.username ?? '',
    avatarRevision: Number(user?.avatarRevision ?? 0),
    avatar: user?.avatarAssetId
      ? {
          assetId: String(user.avatarAssetId),
          revision: Number(user.avatarRevision ?? 0)
        }
      : null,
    emailVerified: user?.emailVerified !== false,
    authenticationMethods
  });
};

export const logoutFromWeb = async (req: Request, res: Response) => {
  setBrowserSessionPrivacyHeaders(res);
  const requestedViewer = String(req.body.viewerId ?? '').trim();
  const accessIdentity = browserAccessSessionIdentity(req);
  let refreshIdentity: Awaited<ReturnType<typeof refreshSessionIdentity>>;
  try {
    refreshIdentity = await refreshSessionIdentity(getCookieValue(req, 'refresh_token'));
  } catch {
    recordSecurityEvent('browser_form_logout_identity_unavailable');
    return res.status(503).type('text/plain').send('The active account could not be confirmed.');
  }
  const credentialIdentities = [accessIdentity, refreshIdentity].filter(
    (identity): identity is NonNullable<typeof identity> => Boolean(identity)
  );
  if (credentialIdentities.length > 0 && (
    !requestedViewer
    || credentialIdentities.some(({ userId }) => userId !== requestedViewer)
  )) {
    recordSecurityEvent('browser_form_logout_viewer_mismatch');
    return res.status(409).type('text/plain').send(
      'The active account changed. Reload the page before signing out.'
    );
  }
  try {
    await revokeBrowserRequestSession(req, credentialIdentities);
    recordSecurityEvent('browser_logout_completed');
  } catch {
    recordSecurityEvent('browser_logout_revocation_failed');
    return res.status(503).type('text/plain').send('Sign out could not be confirmed.');
  }
  // The uncoordinated legacy form is revoke-only: a delayed response must
  // never clear cookies installed by a newer account transition.
  return res.redirect(303, '/finitude?sessionTransition=logout');
};
