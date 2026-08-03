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

const createUser = async (email: string, username: string, password: string) => {
  const normalizedEmail = normalizeEmail(email);

  const existing = await User.findByEmail(normalizedEmail);
  if (existing) {
    const error: ErrorWithStatusCode = new Error('email address already exists!');
    error.statusCode = 409;
    throw error;
  }

  const hashedPassword = await bcrypt.hash(password, 12);

  const user = new User(
    normalizedEmail,
    hashedPassword,
    username,
    [],
    'user'
  );

  return user.save();
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
    const listenerDestination = destination.pathname === '/listen'
      || destination.pathname.startsWith('/listen/');
    if (!contentManagerDestination && !listenerDestination && destination.pathname !== '/') {
      return '/';
    }
    return `${destination.pathname}${destination.search}${destination.hash}`;
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

/** Recovers only a signed session identity so logout can revoke an expired access token. */
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

export const renderSignupPage = (req: Request, res: Response) => {
  res.status(200).send(renderSignupHtml({}));
};

export const renderLoginPage = (req: Request, res: Response) => {
  const returnTo = safeWebReturnTo(req.query.returnTo);
  res.status(200).send(renderLoginHtml({ returnTo }));
};

export const signup = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const errors = validationResult(req);
    // check if there are any validation errors
    if (!errors.isEmpty()) {
      const error: ErrorWithStatusCode = new Error('Validation failed.');
      error.statusCode = 422;
      error.data = errors.array();
      throw error;
    }

    const email = normalizeEmail(req.body.email);
    const username = req.body.username;
    const password = req.body.password;
    createUser(email, username, password)
      .then(result => {
        // return 201 status code for successful creation
        res.status(201).json({
          message: 'User created',
          userId: result.insertedId.toString()
        });
      })
      .catch(err => {
        console.log(err);
        const statusCode = err?.statusCode ?? 500;
        res.status(statusCode).json({
          message: statusCode === 409 ? 'email address already exists!' : 'Creating the user failed.'
        });
      });
  } catch (error: any) {
    // return 500 status code for server error
    if (!error.statusCode) {
      error.statusCode = 500;
    }
    next(error);
  }
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

    await registerEmailAccount(email, password, username, username);
    res.status(202).send(renderSignupHtml({
      successMessage: 'If the account can be created, a verification code has been sent. Verify the email before logging in.'
    }));
  } catch (error: any) {
    console.log(error);
    res.status(error?.statusCode ?? 500).send(renderSignupHtml({
      email: normalizeEmail(req.body.email),
      username: String(req.body.username ?? ''),
      errorMessage: 'Creating the account failed.'
    }));
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
  const identifier = normalizeIdentifier(req.body.identifier ?? req.body.email ?? req.body.username);
  const password = String(req.body.password ?? '');
  const returnTo = safeWebReturnTo(req.body.returnTo);

  if (!identifier || !password) {
    res.status(422).send(renderLoginHtml({
      identifier,
      returnTo,
      errorMessage: 'Identifier and password are required.'
    }));
    return;
  }

  try {
    const authResult = await authenticateUser(identifier, password, req);
    recordSecurityEvent('browser_login_succeeded', {
      userId: authResult.userId,
      sessionId: authResult.sessionId
    });
    setBrowserSessionCookies(res, authResult);
    res.redirect(returnTo || '/');
  } catch (error: any) {
    const message = error?.message || 'Login failed.';
    const statusCode = error?.statusCode ?? 401;
    res.status(statusCode).send(renderLoginHtml({
      identifier,
      returnTo,
      errorMessage: message
    }));
  }
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

  try {
    const authResult = await authenticateUser(identifier, password, req);
    const payload = await loadBrowserSessionPayload(authResult.userId);
    setBrowserSessionCookies(res, authResult);
    recordSecurityEvent('browser_json_login_succeeded', {
      userId: authResult.userId,
      sessionId: authResult.sessionId
    });
    recordAuthFunnelEvent('login', 'password', 'succeeded');
    return res.status(200).json(payload);
  } catch (error: any) {
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
  const refreshToken = getCookieValue(req, 'refresh_token');
  const tokens = await refreshSession(refreshToken);
  if (!tokens) {
    recordSecurityEvent('browser_json_refresh_rejected');
    return res.status(401).json({ message: 'Authentication failed.' });
  }

  // Commit the rotated pair before the profile read so a transient read failure does
  // not strand the browser with the refresh token that was just consumed.
  setBrowserSessionCookies(res, tokens);
  const claims = jwt.verify(tokens.accessToken, getJwtSecret()) as AccessTokenPayload;
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
  return res.status(200).json(await loadBrowserSessionPayload(auth.userId));
};

/** Revokes the refresh session and clears both cookies without a redirect. */
export const browserLogout = async (req: Request, res: Response) => {
  setBrowserSessionPrivacyHeaders(res);
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
  if (requestedViewer && credentialIdentities.some(({ userId }) => userId !== requestedViewer)) {
    recordSecurityEvent('browser_json_logout_viewer_mismatch');
    return res.status(409).json({
      message: 'The active account changed. Refresh the account before trying again.'
    });
  }
  try {
    await revokeBrowserRequestSession(req, credentialIdentities);
    recordSecurityEvent('browser_json_logout_completed');
  } catch {
    // Client-side logout must still complete if server-side revocation is temporarily unavailable.
    recordSecurityEvent('browser_json_logout_revocation_failed');
  } finally {
    clearBrowserSessionCookies(res);
  }
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
  try {
    await revokeBrowserRequestSession(req);
    recordSecurityEvent('browser_logout_completed');
  } catch {
    recordSecurityEvent('browser_logout_revocation_failed');
  } finally {
    clearBrowserSessionCookies(res);
  }
  res.redirect('/');
};
