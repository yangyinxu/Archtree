import { Request, Response, NextFunction } from 'express';
import { validationResult } from 'express-validator';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import User from '../models/user';

/**
 * Interface for Error object with statusCode property
 */
interface ErrorWithStatusCode extends Error {
  statusCode?: number;
  data?: any;
}

const oneDayMs = 24 * 60 * 60 * 1000;

const getSessionDurationMs = () => {
  const configuredDays = Number(process.env.SESSION_DAYS ?? process.env.WEB_SESSION_DAYS ?? 30);
  const safeDays = Number.isFinite(configuredDays)
    ? Math.max(1, Math.min(90, Math.floor(configuredDays)))
    : 30;

  return safeDays * oneDayMs;
};

const setSessionCookie = (res: Response, token: string) => {
  const maxAgeSeconds = Math.floor(getSessionDurationMs() / 1000);
  const expiresAt = new Date(Date.now() + getSessionDurationMs()).toUTCString();
  res.setHeader('Set-Cookie', `session_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}; Expires=${expiresAt}`);
};

const clearSessionCookie = (res: Response) => {
  res.setHeader('Set-Cookie', 'session_token=; Path=/; HttpOnly; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
};

const getJwtSecret = () => {
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    const error: ErrorWithStatusCode = new Error('JWT secret is not configured.');
    error.statusCode = 500;
    throw error;
  }
  return jwtSecret;
};

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
        <input id="signup-password" type="password" name="password" minlength="5" autocomplete="new-password" required />
        <span class="muted">Use at least 5 characters.</span>
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
        <input id="login-password" type="password" name="password" minlength="5" autocomplete="current-password" required />
        <button type="submit">Log in</button>
      </form>
    </section>
    <p class="auth-footer">Need an account? <a href="/auth/signup-web">Create one</a></p>
  </main>
</body>
</html>`;
};

const authenticateUser = async (identifier: string, password: string) => {
  const user = await User.findByIdentifier(identifier);
  if (!user) {
    const error: ErrorWithStatusCode = new Error('A user with this email or username could not be found.');
    error.statusCode = 401;
    throw error;
  }

  const isEqual = await bcrypt.compare(password, user.password);
  if (!isEqual) {
    const error: ErrorWithStatusCode = new Error('Wrong password!');
    error.statusCode = 401;
    throw error;
  }

  const token = jwt.sign(
    {
      email: user.email,
      userId: user._id.toString(),
      role: user.role ?? 'user'
    },
    getJwtSecret(),
    {
      expiresIn: Math.floor(getSessionDurationMs() / 1000)
    }
  );

  return {
    userId: user._id.toString(),
    token,
    role: user.role ?? 'user'
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
    const authResult = await authenticateUser(identifier, password);

    // return 200 status code for successful login
    res.status(200).json({
      token: authResult.token,
      userId: authResult.userId,
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
    const authResult = await authenticateUser(identifier, password);
    setSessionCookie(res, authResult.token);
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

export const logoutFromWeb = (req: Request, res: Response) => {
  clearSessionCookie(res);
  res.redirect('/');
};
