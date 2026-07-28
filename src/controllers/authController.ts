import { Request, Response, NextFunction } from 'express';
import { validationResult } from 'express-validator';
import bcrypt from 'bcryptjs';
import User from '../models/user';
import AuthSession from '../models/authSession';
import {
  createSession,
  createLegacyMigrationToken,
  refreshSession,
  revokeRefreshSession,
  SessionUser
} from '../services/authSessionService';
import {
  clearBrowserSessionCookies,
  getCookieValue,
  setBrowserSessionCookies
} from '../services/authCookieService';
import { recordSecurityEvent } from '../services/securityAuditService';

/**
 * Interface for Error object with statusCode property
 */
interface ErrorWithStatusCode extends Error {
  statusCode?: number;
  data?: any;
}

const normalizeEmail = (email: string) => {
  return String(email ?? '').trim().toLowerCase();
};

const createUser = async (email: string, username: string, password: string, role: string = 'user') => {
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
    role
  );

  return user.save();
};

const normalizeIdentifier = (value: string) => {
  return String(value ?? '').trim();
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

  return {
    userId: user._id.toString(),
    email: user.email,
    role: user.role ?? 'user',
    legacyToken: createLegacyMigrationToken(user as unknown as SessionUser),
    ...(await createSession(user as unknown as SessionUser, req))
  };
};

export const renderSignupPage = (req: Request, res: Response) => {
  res.status(200).send(renderSignupHtml({}));
};

export const renderLoginPage = (req: Request, res: Response) => {
  const returnTo = String(req.query.returnTo ?? '/');
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

    createUser(email, username, password)
      .then(() => {
        res.status(201).send(renderSignupHtml({
          successMessage: 'User created successfully. You can now log in from the app.'
        }));
      })
      .catch(err => {
        console.log(err);
        const statusCode = err?.statusCode ?? 500;
        res.status(statusCode).send(renderSignupHtml({
          email,
          username,
          errorMessage: statusCode === 409 ? 'Email address already exists.' : 'Creating the user failed.'
        }));
      });
  } catch (error: any) {
    if (!error.statusCode) {
      error.statusCode = 500;
    }
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
    if (!error.statusCode) {
      error.statusCode = 500;
    }
    next(error);
  }
};

export const loginFromWeb = async (req: Request, res: Response) => {
  const identifier = normalizeIdentifier(req.body.identifier ?? req.body.email ?? req.body.username);
  const password = String(req.body.password ?? '');
  const returnTo = String(req.body.returnTo ?? '/');

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
  return res.status(200).json(auth);
};

export const logoutFromWeb = async (req: Request, res: Response) => {
  const refreshToken = getCookieValue(req, 'refresh_token');
  if (refreshToken) {
    await revokeRefreshSession(refreshToken);
  }
  recordSecurityEvent('browser_logout_completed');
  clearBrowserSessionCookies(res);
  res.redirect('/');
};
