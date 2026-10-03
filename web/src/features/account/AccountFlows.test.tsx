import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';

import { advanceAccountEpoch } from '../../api/accountEpoch';
import { browserSessionQueryKey } from '../../api/session';
import { AccountPage } from './AccountPage';
import { AccountSessionsPage } from './AccountSessionsPage';
import { ChangePasswordPage } from './ChangePasswordPage';
import { ForgotPasswordPage } from './ForgotPasswordPage';
import { LoginPage } from './LoginPage';
import { RegisterCompletePage } from './RegisterCompletePage';
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
  headers: {
    'Content-Type': 'application/json',
    'X-Finitude-Account-Viewer': 'listener-1'
  }
});

const linkToken = 'Abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE';

/** Exposes the router location so tests can prove link tokens never stay in the URL or router state. */
const LocationProbe = () => {
  const location = useLocation();
  return <div data-testid="location" hidden>{JSON.stringify({
    pathname: location.pathname,
    hash: location.hash,
    state: location.state
  })}</div>;
};

const currentLocation = () => JSON.parse(screen.getByTestId('location').textContent ?? '{}') as {
  pathname: string;
  hash: string;
  state: unknown;
};

const renderAccountRoutes = (
  initialEntry: string | { pathname: string; state?: unknown },
  session: unknown = null
) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(browserSessionQueryKey, session);
  const result = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <LocationProbe />
        <Routes>
          <Route path="/" element={<h1>Home</h1>} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/social/invitations/:invitationId" element={<h1>Invitation destination</h1>} />
          <Route path="/social/invitations" element={<h1>Invitation list destination</h1>} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/register/complete" element={<RegisterCompletePage />} />
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

test('a reloaded invitation login continues to its safe detail only after successful authentication', async () => {
  const user = userEvent.setup();
  const currentSession = { user: { id: 'listener-1', email: 'listener@example.com', role: 'user', displayName: 'Quiet Listener',
    avatarRevision: 0, avatar: null, emailVerified: true, authenticationMethods: ['password'] } };
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path === '/auth/browser/capabilities') return jsonResponse(capabilities);
    if (path === '/auth/browser/login') return jsonResponse(currentSession);
    throw new Error(`Unexpected request ${path}`);
  }));
  renderAccountRoutes('/login?returnTo=%2Fsocial%2Finvitations%2Fi_abc-123');
  await user.type(screen.getByLabelText('Email or username'), 'listener@example.com');
  await user.type(screen.getByLabelText('Password'), 'a private password');
  expect(screen.queryByRole('heading', { name: 'Invitation destination' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Log in' }));
  expect(await screen.findByRole('heading', { name: 'Invitation destination' })).toBeVisible();
});

test('an already signed-in viewer explicitly continues to the invitation without automatic navigation', async () => {
  const user = userEvent.setup();
  vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(capabilities)));
  renderAccountRoutes('/login?returnTo=%2Fsocial%2Finvitations%2Fi_abc-123', { user: { id: 'listener-1', displayName: 'Quiet Listener' } });
  expect(screen.queryByRole('heading', { name: 'Invitation destination' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Continue to room invitations' }));
  expect(screen.getByRole('heading', { name: 'Invitation destination' })).toBeVisible();
});

test('registration asks only for an email and shows the same status for every address', async () => {
  const user = userEvent.setup();
  const fetchMock = vi.fn(async (path: string) => {
    if (path === '/auth/browser/capabilities') return jsonResponse(capabilities);
    if (path === '/auth/browser/registration/request') {
      return jsonResponse({ message: 'Check your email for the next step.' }, 202);
    }
    throw new Error(`Unexpected request ${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  renderAccountRoutes('/register');

  await screen.findByRole('button', { name: 'Send link' });
  expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
  expect(screen.queryByLabelText(/Name/)).not.toBeInTheDocument();
  await user.type(screen.getByLabelText('Email'), 'new-listener@example.test');
  await user.click(screen.getByRole('button', { name: 'Send link' }));
  const linkSent = 'Check your email. We sent a message to this address with the next step. Registration links expire after 30 minutes.';
  // Only the echoed address, which the listener typed, differs between addresses.
  expect((await screen.findByRole('status')).textContent).toBe(`${linkSent} Sent to new-listener@example.test`);

  await user.clear(screen.getByLabelText('Email'));
  await user.type(screen.getByLabelText('Email'), 'existing-listener@example.test');
  await user.click(screen.getByRole('button', { name: 'Send link' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe(`${linkSent} Sent to existing-listener@example.test`));
  expect(screen.getByLabelText('Email')).toHaveValue('existing-listener@example.test');
  expect(fetchMock).toHaveBeenNthCalledWith(2, '/auth/browser/registration/request', expect.objectContaining({
    body: JSON.stringify({ email: 'new-listener@example.test' }),
    method: 'POST'
  }));
  expect(fetchMock).toHaveBeenNthCalledWith(3, '/auth/browser/registration/request', expect.objectContaining({
    body: JSON.stringify({ email: 'existing-listener@example.test' })
  }));
});

test('registration request failures, including rate limits, use the generic request error', async () => {
  const user = userEvent.setup();
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path === '/auth/browser/capabilities') return jsonResponse(capabilities);
    return jsonResponse({ message: 'Too many requests. Please try again later.' }, 429);
  }));
  renderAccountRoutes('/register');

  await user.type(await screen.findByLabelText('Email'), 'listener@example.test');
  await user.click(screen.getByRole('button', { name: 'Send link' }));

  expect(await screen.findByRole('alert')).toHaveTextContent('Finitude could not complete that request. Please try again.');
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});

test('registration stays closed when the deployment cannot send registration links', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ...capabilities, emailRegistration: false })));
  renderAccountRoutes('/register');

  expect(await screen.findByText('Email registration is not available on this deployment.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Send link' })).not.toBeInTheDocument();
});

test('the completion page captures the link token, strips the fragment, and creates the account', async () => {
  const user = userEvent.setup();
  const fetchMock = vi.fn(async (path: string, _init?: RequestInit) => {
    if (path === '/auth/browser/registration/inspect') return jsonResponse({ email: 'listener@example.test' });
    if (path === '/auth/browser/registration/complete') return jsonResponse({ email: 'listener@example.test' }, 201);
    if (path === '/auth/browser/capabilities') return jsonResponse(capabilities);
    throw new Error(`Unexpected request ${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  renderAccountRoutes(`/register/complete#token=${linkToken}`);

  expect(await screen.findByLabelText('Display name')).toBeInTheDocument();
  expect(currentLocation()).toEqual({ pathname: '/register/complete', hash: '', state: null });
  expect(screen.getByLabelText('Email')).toHaveValue('listener@example.test');
  expect(screen.getByLabelText('Email')).toHaveAttribute('readonly');
  expect(screen.getByRole('heading', { level: 1, name: 'Set up your listener account.' })).toHaveFocus();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledWith('/auth/browser/registration/inspect', expect.objectContaining({
    body: JSON.stringify({ token: linkToken }),
    method: 'POST'
  }));

  await user.type(screen.getByLabelText('Display name'), '  Quiet Listener ');
  await user.type(screen.getByLabelText('Password'), 'a private password');
  await user.type(screen.getByLabelText('Confirm password'), 'a private password');
  await user.click(screen.getByRole('button', { name: 'Create account' }));

  expect(await screen.findByRole('heading', { name: 'Log in with password' })).toBeInTheDocument();
  expect(screen.getByLabelText('Email or username')).toHaveValue('listener@example.test');
  expect(screen.getByRole('status')).toHaveTextContent(
    'Your account is ready. Log in with your email and new password here or in the Finitude app.'
  );
  expect(fetchMock).toHaveBeenCalledWith('/auth/browser/registration/complete', expect.objectContaining({
    body: JSON.stringify({ token: linkToken, password: 'a private password', displayName: 'Quiet Listener' }),
    method: 'POST'
  }));
  expect(JSON.stringify(currentLocation())).not.toContain(linkToken);
});

test('the completion page survives StrictMode and keeps the token after stripping it', async () => {
  const user = userEvent.setup();
  const fetchMock = vi.fn(async (path: string, _init?: RequestInit) => jsonResponse(
    { email: 'listener@example.test' },
    path === '/auth/browser/registration/complete' ? 201 : 200
  ));
  vi.stubGlobal('fetch', fetchMock);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[`/register/complete#token=${linkToken}`]}>
          <LocationProbe />
          <Routes>
            <Route path="/register/complete" element={<RegisterCompletePage />} />
            <Route path="/login" element={<h1>Login destination</h1>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </StrictMode>
  );

  expect(await screen.findByLabelText('Display name')).toBeInTheDocument();
  expect(currentLocation().hash).toBe('');
  const inspections = fetchMock.mock.calls.filter(([path]) => path === '/auth/browser/registration/inspect');
  expect(inspections.length).toBeGreaterThanOrEqual(1);
  await user.type(screen.getByLabelText('Display name'), 'Quiet Listener');
  await user.type(screen.getByLabelText('Password'), 'a private password');
  await user.type(screen.getByLabelText('Confirm password'), 'a private password');
  await user.click(screen.getByRole('button', { name: 'Create account' }));

  expect(await screen.findByRole('heading', { name: 'Login destination' })).toBeInTheDocument();
  const completion = fetchMock.mock.calls.find(([path]) => path === '/auth/browser/registration/complete');
  expect(JSON.parse(String(completion?.[1]?.body))).toMatchObject({ token: linkToken });
});

test('the completion page treats a missing or malformed token as an invalid link without a request', async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  renderAccountRoutes('/register/complete#token=not-a-real-token');

  expect(await screen.findByRole('heading', { level: 1, name: 'This link can’t be used' })).toBeInTheDocument();
  expect(screen.getByText('This link is invalid, has expired, or was already used. Request a new link to continue.')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Request a new link' })).toHaveAttribute('href', '/register');
  expect(currentLocation().hash).toBe('');
  expect(fetchMock).not.toHaveBeenCalled();
});

test.each([
  [400, { code: 'link_invalid', message: 'This link is invalid, expired, or already used.' }, 'This link can’t be used'],
  [409, { code: 'email_already_registered', message: 'This email already has an account.' }, 'This email already has an account']
])('the completion page maps an inspection %i to its dedicated state', async (status, body, heading) => {
  vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(body, status)));
  renderAccountRoutes(`/register/complete#token=${linkToken}`);

  expect(await screen.findByRole('heading', { level: 1, name: heading })).toHaveFocus();
  expect(screen.queryByLabelText('Display name')).not.toBeInTheDocument();
  if (status === 409) {
    expect(screen.getByText('Log in with your password, or reset it if you’ve forgotten it.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Log in' })).toHaveAttribute('href', '/login');
    expect(screen.getByRole('link', { name: 'Forgot password?' })).toHaveAttribute('href', '/forgot-password');
  }
});

test('the completion page retries an inspection that failed for a transient reason', async () => {
  const user = userEvent.setup();
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(jsonResponse({ message: 'Unavailable.' }, 503))
    .mockResolvedValueOnce(jsonResponse({ email: 'listener@example.test' }));
  vi.stubGlobal('fetch', fetchMock);
  renderAccountRoutes(`/register/complete#token=${linkToken}`);

  expect(await screen.findByRole('alert')).toHaveTextContent('Finitude could not complete that request. Please try again.');
  await user.click(screen.getByRole('button', { name: 'Try again' }));

  expect(await screen.findByLabelText('Display name')).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock).toHaveBeenLastCalledWith('/auth/browser/registration/inspect', expect.objectContaining({
    body: JSON.stringify({ token: linkToken })
  }));
});

test('the completion page maps rejected fields and spent links from the server', async () => {
  const user = userEvent.setup();
  const completions = [
    jsonResponse({ code: 'invalid_password', message: 'Choose a less common password.' }, 422),
    jsonResponse({ code: 'invalid_display_name', message: 'Enter a display name between 1 and 80 characters.' }, 422),
    jsonResponse({ message: 'Finitude could not complete that request.' }, 500),
    jsonResponse({ code: 'link_invalid', message: 'This link is invalid, expired, or already used.' }, 400)
  ];
  const fetchMock = vi.fn(async (path: string) => {
    if (path === '/auth/browser/registration/inspect') return jsonResponse({ email: 'listener@example.test' });
    if (path === '/auth/browser/registration/complete') return completions.shift()!;
    throw new Error(`Unexpected request ${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  renderAccountRoutes(`/register/complete#token=${linkToken}`);

  await user.type(await screen.findByLabelText('Display name'), 'Quiet Listener');
  await user.type(screen.getByLabelText('Password'), 'a private password');
  await user.type(screen.getByLabelText('Confirm password'), 'a private password');
  const submit = () => user.click(screen.getByRole('button', { name: 'Create account' }));

  await submit();
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Choose a different password. Use 12–256 characters and avoid common passwords.'
  );
  await submit();
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Enter a display name between 1 and 80 characters.'));
  await submit();
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Finitude could not complete that request. Please try again.'));
  await submit();
  expect(await screen.findByRole('heading', { level: 1, name: 'This link can’t be used' })).toHaveFocus();
  expect(screen.queryByLabelText('Display name')).not.toBeInTheDocument();
});

test('the completion page checks the display name and password confirmation before submitting', async () => {
  const user = userEvent.setup();
  const fetchMock = vi.fn(async () => jsonResponse({ email: 'listener@example.test' }));
  vi.stubGlobal('fetch', fetchMock);
  renderAccountRoutes(`/register/complete#token=${linkToken}`);

  await user.type(await screen.findByLabelText('Display name'), '   ');
  await user.type(screen.getByLabelText('Password'), 'a private password');
  await user.type(screen.getByLabelText('Confirm password'), 'a private password');
  await user.click(screen.getByRole('button', { name: 'Create account' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Enter a display name between 1 and 80 characters.');

  await user.type(screen.getByLabelText('Display name'), 'Quiet Listener');
  await user.type(screen.getByLabelText('Confirm password'), ' mismatch');
  await user.click(screen.getByRole('button', { name: 'Create account' }));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('The passwords do not match.'));
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('the completion page maps a 409 after submission to the existing-account state', async () => {
  const user = userEvent.setup();
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path === '/auth/browser/registration/inspect') return jsonResponse({ email: 'listener@example.test' });
    return jsonResponse({ code: 'email_already_registered', message: 'This email already has an account.' }, 409);
  }));
  renderAccountRoutes(`/register/complete#token=${linkToken}`);

  await user.type(await screen.findByLabelText('Display name'), 'Quiet Listener');
  await user.type(screen.getByLabelText('Password'), 'a private password');
  await user.type(screen.getByLabelText('Confirm password'), 'a private password');
  await user.click(screen.getByRole('button', { name: 'Create account' }));

  expect(await screen.findByRole('heading', { level: 1, name: 'This email already has an account' })).toHaveFocus();
  await user.click(screen.getByRole('link', { name: 'Log in' }));
  expect(screen.getByLabelText('Email or username')).toHaveValue('listener@example.test');
});

test('verification-required login shows the verification guidance and a prefilled link request', async () => {
  const user = userEvent.setup();
  const fetchMock = vi.fn(async (path: string) => {
    if (path === '/auth/browser/capabilities') return jsonResponse(capabilities);
    if (path === '/auth/browser/login') {
      return jsonResponse({
        code: 'email_verification_required',
        message: 'Verify your email to sign in. Open the verification link we sent to your email address, then sign in again.'
      }, 403);
    }
    if (path === '/auth/browser/email-verification/request') {
      return jsonResponse({ message: 'If this address needs verification, a link has been sent.' }, 202);
    }
    throw new Error(`Unexpected request ${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  renderAccountRoutes('/login');

  await user.type(screen.getByLabelText('Email or username'), 'legacy@example.test');
  await user.type(screen.getByLabelText('Password'), 'a private password');
  await user.click(screen.getByRole('button', { name: 'Log in' }));

  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Verify your email to log in. We sent a verification link to your email address. Open it, then log in again.'
  );
  await user.click(screen.getByRole('link', { name: 'Didn’t get the email? Send a new verification link' }));
  expect(screen.getByRole('heading', { level: 1, name: 'Get a verification link.' })).toBeInTheDocument();
  expect(screen.getByLabelText('Email')).toHaveValue('legacy@example.test');
  await user.click(screen.getByRole('button', { name: 'Send verification link' }));

  expect(await screen.findByRole('status')).toHaveTextContent(
    'If this address needs verification, we sent a link. Check your email.'
  );
  expect(fetchMock).toHaveBeenCalledWith('/auth/browser/email-verification/request', expect.objectContaining({
    body: JSON.stringify({ email: 'legacy@example.test' }),
    method: 'POST'
  }));
});

test('keeps username login and does not prefill it as a verification email', async () => {
  const user = userEvent.setup();
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path === '/auth/browser/capabilities') return jsonResponse(capabilities);
    if (path === '/auth/browser/login') {
      return jsonResponse({ code: 'email_verification_required', message: 'Verify your email to sign in.' }, 403);
    }
    throw new Error(`Unexpected request ${path}`);
  }));
  renderAccountRoutes('/login');

  const identifier = screen.getByLabelText('Email or username');
  expect(identifier).toHaveAttribute('type', 'text');
  expect(identifier).toHaveAttribute('autocomplete', 'username');
  await user.type(identifier, 'legacy-listener');
  await user.type(screen.getByLabelText('Password'), 'a private password');
  await user.click(screen.getByRole('button', { name: 'Log in' }));
  await user.click(await screen.findByRole('link', { name: 'Didn’t get the email? Send a new verification link' }));

  expect(screen.getByRole('heading', { level: 1, name: 'Get a verification link.' })).toBeInTheDocument();
  expect(screen.getByLabelText('Email')).toHaveValue('');
  expect(currentLocation().state).toBeNull();
});

test.each([
  ['a 403 without a code', { message: 'Forbidden.' }],
  ['a 403 with another code', { code: 'csrf_rejected', message: 'Forbidden.' }]
])('login shows the generic error for %s', async (_label, body) => {
  const user = userEvent.setup();
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path === '/auth/browser/capabilities') return jsonResponse(capabilities);
    return jsonResponse(body, 403);
  }));
  renderAccountRoutes('/login');

  await user.type(screen.getByLabelText('Email or username'), 'listener@example.test');
  await user.type(screen.getByLabelText('Password'), 'a private password');
  await user.click(screen.getByRole('button', { name: 'Log in' }));

  expect(await screen.findByRole('alert')).toHaveTextContent('Finitude could not log you in. Please try again.');
  expect(screen.queryByRole('link', { name: /verification link/ })).not.toBeInTheDocument();
});

test('finishes login navigation after a cross-tab event already reconciled the same viewer', async () => {
  const user = userEvent.setup();
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
  let releaseLogin!: () => void;
  const loginGate = new Promise<void>((resolve) => { releaseLogin = resolve; });
  const fetchMock = vi.fn(async (path: string) => {
    if (path === '/auth/browser/capabilities') return jsonResponse(capabilities);
    if (path === '/auth/browser/login') {
      await loginGate;
      return jsonResponse(currentSession);
    }
    throw new Error(`Unexpected request ${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  const { queryClient } = renderAccountRoutes('/login');

  await user.type(screen.getByLabelText('Email or username'), 'listener@example.com');
  await user.type(screen.getByLabelText('Password'), 'a private password');
  await user.click(screen.getByRole('button', { name: 'Log in' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
    '/auth/browser/login',
    expect.objectContaining({ method: 'POST' })
  ));

  advanceAccountEpoch();
  queryClient.setQueryData(browserSessionQueryKey, currentSession);
  releaseLogin();

  expect(await screen.findByRole('heading', { name: 'Home' })).toBeInTheDocument();
});

test('does not navigate for a stale login after reconciliation selected another viewer', async () => {
  const user = userEvent.setup();
  const loginSession = {
    user: {
      id: 'listener-b',
      email: 'listener-b@example.com',
      role: 'user',
      displayName: 'Listener B',
      avatarRevision: 0,
      avatar: null,
      emailVerified: true,
      authenticationMethods: ['password']
    }
  };
  const reconciledSession = {
    user: {
      ...loginSession.user,
      id: 'listener-c',
      email: 'listener-c@example.com',
      displayName: 'Listener C'
    }
  };
  let releaseLogin!: () => void;
  const loginGate = new Promise<void>((resolve) => { releaseLogin = resolve; });
  const fetchMock = vi.fn(async (path: string) => {
    if (path === '/auth/browser/capabilities') return jsonResponse(capabilities);
    if (path === '/auth/browser/login') {
      await loginGate;
      return jsonResponse(loginSession);
    }
    throw new Error(`Unexpected request ${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  const { queryClient } = renderAccountRoutes('/login');

  await user.type(screen.getByLabelText('Email or username'), 'listener-b@example.com');
  await user.type(screen.getByLabelText('Password'), 'a private password');
  await user.click(screen.getByRole('button', { name: 'Log in' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
    '/auth/browser/login',
    expect.objectContaining({ method: 'POST' })
  ));

  advanceAccountEpoch();
  queryClient.setQueryData(browserSessionQueryKey, reconciledSession);
  releaseLogin();
  await waitFor(() => expect(queryClient.getMutationCache().getAll()[0]?.state.status)
    .toBe('success'));

  expect(screen.getByRole('heading', {
    name: 'You are already listening as Listener C'
  })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Home' })).not.toBeInTheDocument();
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

test('a verification link confirms only after an explicit click, then returns to Login', async () => {
  const user = userEvent.setup();
  const fetchMock = vi.fn(async (path: string) => {
    if (path === '/auth/browser/email-verification/inspect') return jsonResponse({ email: 'legacy@example.test' });
    if (path === '/auth/browser/email-verification/confirm') return new Response(null, { status: 204 });
    if (path === '/auth/browser/capabilities') return jsonResponse(capabilities);
    if (path === '/auth/browser/session') return jsonResponse({ message: 'Unauthorized' }, 401);
    throw new Error(`Unexpected request ${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  const { queryClient } = renderAccountRoutes(`/verify-email#token=${linkToken}`);
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

  expect(await screen.findByRole('button', { name: 'Verify email' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { level: 1, name: 'Confirm this email is yours.' })).toBeInTheDocument();
  expect(screen.getByText(/Your password doesn’t change\./)).toBeInTheDocument();
  expect(screen.getByLabelText('Email')).toHaveValue('legacy@example.test');
  expect(currentLocation()).toEqual({ pathname: '/verify-email', hash: '', state: null });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock).not.toHaveBeenCalledWith('/auth/browser/email-verification/confirm', expect.anything());

  await user.click(screen.getByRole('button', { name: 'Verify email' }));

  expect(await screen.findByRole('heading', { name: 'Log in with password' })).toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('Email verified. You can now log in.');
  expect(screen.getByLabelText('Email or username')).toHaveValue('legacy@example.test');
  expect(invalidate).toHaveBeenCalledWith({ queryKey: browserSessionQueryKey });
  expect(fetchMock).toHaveBeenCalledWith('/auth/browser/email-verification/confirm', expect.objectContaining({
    body: JSON.stringify({ token: linkToken }),
    method: 'POST'
  }));
});

test('an unusable verification link offers a new link request', async () => {
  const user = userEvent.setup();
  const fetchMock = vi.fn(async (path: string) => {
    if (path === '/auth/browser/email-verification/inspect') return jsonResponse({ email: 'legacy@example.test' });
    if (path === '/auth/browser/email-verification/confirm') {
      return jsonResponse({ code: 'link_invalid', message: 'This link is invalid, expired, or already used.' }, 400);
    }
    if (path === '/auth/browser/email-verification/request') {
      return jsonResponse({ message: 'If this address needs verification, a link has been sent.' }, 202);
    }
    throw new Error(`Unexpected request ${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  renderAccountRoutes(`/verify-email#token=${linkToken}`);

  await user.click(await screen.findByRole('button', { name: 'Verify email' }));

  expect(await screen.findByRole('heading', { level: 1, name: 'This link can’t be used' })).toHaveFocus();
  expect(screen.getByText(
    'This link is invalid, has expired, or was already used. Enter your email to get a new verification link.'
  )).toBeInTheDocument();
  expect(screen.getByLabelText('Email')).toHaveValue('legacy@example.test');
  await user.click(screen.getByRole('button', { name: 'Send verification link' }));
  expect(await screen.findByRole('status')).toHaveTextContent(
    'If this address needs verification, we sent a link. Check your email.'
  );
});

test('an expired verification link shows the request form without a confirm button', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(
    { code: 'link_invalid', message: 'This link is invalid, expired, or already used.' },
    400
  )));
  renderAccountRoutes(`/verify-email#token=${linkToken}`);

  expect(await screen.findByRole('heading', { level: 1, name: 'This link can’t be used' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Verify email' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Send verification link' })).toBeInTheDocument();
  expect(screen.getByLabelText('Email')).toHaveValue('');
});

test('Account verification guidance lands on the prefilled link request', () => {
  vi.stubGlobal('fetch', vi.fn());
  renderAccountRoutes({ pathname: '/verify-email', state: { email: 'legacy@example.test' } });

  expect(screen.getByRole('heading', { level: 1, name: 'Get a verification link.' })).toBeInTheDocument();
  expect(screen.getByText(
    'Enter your account email. If it still needs verification, we’ll send a link that expires after 30 minutes.'
  )).toBeInTheDocument();
  expect(screen.getByLabelText('Email')).toHaveValue('legacy@example.test');
});

test('a completed link for another address keeps the signed-in account and shows the outcome', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(capabilities)));
  renderAccountRoutes(
    { pathname: '/login', state: { email: 'new@example.test', notice: 'Your account is ready.' } },
    { user: { id: 'listener-1', displayName: 'Quiet Listener' } }
  );

  expect(screen.getByRole('heading', { name: 'You are already listening as Quiet Listener' })).toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('Your account is ready.');
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
      return new Response(null, {
        status: 204,
        headers: { 'X-Finitude-Account-Viewer': 'listener-1' }
      });
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
  const fetchMock = vi.fn().mockResolvedValue(new Response(null, {
    status: 204,
    headers: { 'X-Finitude-Account-Viewer': 'listener-1' }
  }));
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
