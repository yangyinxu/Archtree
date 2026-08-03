import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';

import { browserSessionQueryKey } from '../../api/session';
import { AccountPage } from './AccountPage';
import { AccountSessionsPage } from './AccountSessionsPage';
import { ChangePasswordPage } from './ChangePasswordPage';
import { ForgotPasswordPage } from './ForgotPasswordPage';
import { LoginPage } from './LoginPage';
import { RegisterPage } from './RegisterPage';
import { ResetPasswordPage } from './ResetPasswordPage';
import { VerifyEmailPage } from './VerifyEmailPage';

const capabilities = {
  password: true,
  emailRegistration: true,
  apple: false,
  google: false,
  passkey: false
};

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' }
});

const renderAccountRoutes = (
  initialEntry: string | { pathname: string; state?: unknown },
  session: unknown = null
) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(browserSessionQueryKey, session);
  const result = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/verify-email" element={<VerifyEmailPage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route path="/account" element={<AccountPage />} />
          <Route path="/account/sessions" element={<AccountSessionsPage />} />
          <Route path="/account/password" element={<ChangePasswordPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
  return { queryClient, ...result };
};

test('registers then carries the email privately into verification', async () => {
  const user = userEvent.setup();
  const fetchMock = vi.fn(async (path: string) => {
    if (path === '/auth/browser/capabilities') return jsonResponse(capabilities);
    if (path === '/auth/browser/register') {
      return jsonResponse({ message: 'If the account can use this action, an email has been sent.' }, 202);
    }
    throw new Error(`Unexpected request ${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  renderAccountRoutes('/register');

  await screen.findByRole('button', { name: 'Create account' });
  await user.type(screen.getByLabelText('Name (optional)'), 'Quiet Listener');
  await user.type(screen.getByLabelText('Email'), 'listener@example.com');
  await user.type(screen.getByLabelText('Password'), 'a private password');
  await user.type(screen.getByLabelText('Confirm password'), 'a private password');
  await user.click(screen.getByRole('button', { name: 'Create account' }));

  expect(await screen.findByRole('heading', { name: 'Verify your email' })).toBeInTheDocument();
  expect(screen.getByLabelText('Email')).toHaveValue('listener@example.com');
  expect(screen.getByRole('status')).toHaveTextContent('If this address can be registered');
  expect(fetchMock).toHaveBeenCalledWith('/auth/browser/register', expect.objectContaining({ method: 'POST' }));
});

test('keeps username login and does not prefill it as a verification email', async () => {
  const user = userEvent.setup();
  const fetchMock = vi.fn(async (path: string) => {
    if (path === '/auth/browser/capabilities') return jsonResponse(capabilities);
    if (path === '/auth/browser/login') {
      return jsonResponse({ message: 'Verify your email before signing in.' }, 403);
    }
    throw new Error(`Unexpected request ${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  renderAccountRoutes('/login');

  const identifier = screen.getByLabelText('Email or username');
  expect(identifier).toHaveAttribute('type', 'text');
  expect(identifier).toHaveAttribute('autocomplete', 'username');
  await user.type(identifier, 'legacy-listener');
  await user.type(screen.getByLabelText('Password'), 'a private password');
  await user.click(screen.getByRole('button', { name: 'Log in' }));
  await user.click(await screen.findByRole('link', { name: 'Verify your email or request a new code' }));

  expect(screen.getByRole('heading', { name: 'Verify your email' })).toBeInTheDocument();
  expect(screen.getByLabelText('Email')).toHaveValue('');
});

test('password recovery keeps its success response non-enumerating', async () => {
  const user = userEvent.setup();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
    message: 'If the account can use this action, an email has been sent.'
  }, 202)));
  renderAccountRoutes('/forgot-password');

  await user.type(screen.getByLabelText('Email'), 'unknown@example.com');
  await user.click(screen.getByRole('button', { name: 'Send reset code' }));

  expect(await screen.findByRole('status')).toHaveTextContent(
    'If this address can reset a password, a recovery email has been sent.'
  );
  await user.click(screen.getByRole('button', { name: 'Enter reset code' }));
  expect(screen.getByLabelText('Email')).toHaveValue('unknown@example.com');
});

test('verifies email and announces the outcome on Login', async () => {
  const user = userEvent.setup();
  const fetchMock = vi.fn(async (path: string) => {
    if (path === '/auth/browser/email/verify') return new Response(null, { status: 204 });
    if (path === '/auth/browser/capabilities') return jsonResponse(capabilities);
    throw new Error(`Unexpected request ${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  renderAccountRoutes({ pathname: '/verify-email', state: { email: 'listener@example.com' } });

  await user.type(screen.getByLabelText('Verification code'), '123456');
  await user.click(screen.getByRole('button', { name: 'Verify email' }));

  expect(await screen.findByRole('heading', { name: 'Log in with password' })).toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('Email verified. You can now log in.');
});

test('resetting the current account removes its cached identity and private queries', async () => {
  const user = userEvent.setup();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
  const currentSession = {
    user: {
      id: 'listener-1',
      email: 'listener@example.com',
      role: 'user',
      displayName: 'Quiet Listener',
      avatarRevision: 0,
      avatar: null,
      emailVerified: true,
      authenticationMethods: ['password']
    }
  };
  const { queryClient } = renderAccountRoutes(
    { pathname: '/reset-password', state: { email: 'listener@example.com' } },
    currentSession
  );
  queryClient.setQueryData(['account', 'listener-1', 'private'], { secret: true });

  await user.type(screen.getByLabelText('Reset code'), '123456');
  await user.type(screen.getByLabelText('New password'), 'a different password');
  await user.type(screen.getByLabelText('Confirm new password'), 'a different password');
  await user.click(screen.getByRole('button', { name: 'Reset password' }));

  await waitFor(() => expect(queryClient.getQueryData(['account', 'listener-1', 'private'])).toBeUndefined());
  expect(queryClient.getQueryData(browserSessionQueryKey)).toBeNull();
});

test('Account shows verified identity, methods, and stable security links', () => {
  renderAccountRoutes('/account', {
    user: {
      id: 'listener-1',
      email: 'listener@example.com',
      role: 'user',
      displayName: 'Quiet Listener',
      avatarRevision: 0,
      avatar: null,
      emailVerified: true,
      authenticationMethods: ['password', 'google']
    }
  });

  expect(screen.getAllByText('Quiet Listener')).toHaveLength(2);
  expect(screen.getByText('Email verified')).toBeInTheDocument();
  expect(screen.getByText('Password, Google')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /Signed-in devices/ })).toHaveAttribute('href', '/account/sessions');
  expect(screen.getByRole('link', { name: /Change password/ })).toHaveAttribute('href', '/account/password');
});

test('signed-in devices use friendly labels and revoke only another session', async () => {
  const user = userEvent.setup();
  const rawUserAgent = 'Mozilla/5.0 private raw user agent';
  const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/auth/sessions' && !init?.method) {
      return jsonResponse({
        sessions: [
          {
            id: 'current-session',
            createdAt: '2026-08-01T12:00:00.000Z',
            lastUsedAt: '2026-08-02T12:00:00.000Z',
            expiresAt: '2026-09-01T12:00:00.000Z',
            userAgent: rawUserAgent,
            deviceName: 'Safari on Mac',
            deviceType: 'computer',
            isCurrent: true
          },
          {
            id: 'other-session',
            createdAt: '2026-07-01T12:00:00.000Z',
            lastUsedAt: '2026-07-02T12:00:00.000Z',
            expiresAt: '2026-09-01T12:00:00.000Z',
            userAgent: rawUserAgent,
            deviceName: 'Finitude on iPhone',
            deviceType: 'phone',
            isCurrent: false
          }
        ]
      });
    }
    if (path === '/auth/sessions/other-session' && init?.method === 'DELETE') {
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request ${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  renderAccountRoutes('/account/sessions', {
    user: {
      id: 'listener-1',
      email: 'listener@example.com',
      role: 'user',
      displayName: 'Quiet Listener',
      avatarRevision: 0,
      avatar: null,
      emailVerified: true,
      authenticationMethods: ['password']
    }
  });

  expect(await screen.findByText('Safari on Mac')).toBeInTheDocument();
  expect(screen.getByText('Finitude on iPhone')).toBeInTheDocument();
  expect(screen.queryByText(rawUserAgent)).not.toBeInTheDocument();
  expect(screen.getAllByRole('button', { name: 'Remove' })).toHaveLength(1);
  await user.click(screen.getByRole('button', { name: 'Remove' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
    '/auth/sessions/other-session',
    expect.objectContaining({ credentials: 'same-origin', method: 'DELETE' })
  ));
});

test('changing a password keeps the current session and announces other-device revocation', async () => {
  const user = userEvent.setup();
  const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetchMock);
  renderAccountRoutes('/account/password', {
    user: {
      id: 'listener-1',
      email: 'listener@example.com',
      role: 'user',
      displayName: 'Quiet Listener',
      avatarRevision: 0,
      avatar: null,
      emailVerified: true,
      authenticationMethods: ['password']
    }
  });

  await user.type(screen.getByLabelText('Current password'), 'the current password');
  await user.type(screen.getByLabelText('New password'), 'a different password');
  await user.type(screen.getByLabelText('Confirm new password'), 'a different password');
  await user.click(screen.getByRole('button', { name: 'Change password' }));

  expect(await screen.findByRole('status')).toHaveTextContent(
    'Password updated. Every other signed-in device has been logged out.'
  );
  expect(fetchMock).toHaveBeenCalledWith('/auth/password/change', expect.objectContaining({
    body: JSON.stringify({
      currentPassword: 'the current password',
      newPassword: 'a different password'
    }),
    credentials: 'same-origin',
    method: 'POST'
  }));
});
