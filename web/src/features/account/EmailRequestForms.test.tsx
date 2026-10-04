import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';

import { browserSessionQueryKey } from '../../api/session';
import { emailSuggestionDelayMilliseconds } from './AuthFormSupport';
import { ForgotPasswordPage } from './ForgotPasswordPage';
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

const undeliverableBody = {
  code: 'email_domain_undeliverable',
  message: 'This email domain cannot receive email. Check the address and try again.'
};
const domainError = 'This email domain can’t receive mail. Check the spelling and try again.';
const genericError = 'Finitude could not complete that request. Please try again.';

/** The three public forms that email a typed address, with their endpoint and accepted copy. */
const emailRequestPages = [
  {
    name: 'registration',
    route: '/register',
    endpoint: '/auth/browser/registration/request',
    submit: 'Send link',
    accepted: 'Check your email. We sent a message to this address with the next step. Registration links expire after 30 minutes.'
  },
  {
    name: 'verification-link request',
    route: '/verify-email',
    endpoint: '/auth/browser/email-verification/request',
    submit: 'Send verification link',
    accepted: 'If this address needs verification, we sent a link. Check your email.'
  },
  {
    name: 'password recovery',
    route: '/forgot-password',
    endpoint: '/auth/browser/password/forgot',
    submit: 'Send reset code',
    accepted: 'If this address can reset a password, a recovery email has been sent.'
  }
] as const;

type EmailRequestPage = (typeof emailRequestPages)[number];

/**
 * Answers like the server: `.invalid` domains (reserved, never resolvable) are
 * rejected as undeliverable, every other valid address is accepted.
 */
const installEmailServer = (page: EmailRequestPage) => {
  const requests: string[] = [];
  const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/auth/browser/capabilities') return jsonResponse(capabilities);
    if (path === page.endpoint) {
      const { email } = JSON.parse(String(init?.body)) as { email: string };
      requests.push(email);
      if (email.endsWith('.invalid')) return jsonResponse(undeliverableBody, 422);
      return jsonResponse({ message: 'Accepted.' }, 202);
    }
    throw new Error(`Unexpected request ${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, requests };
};

const renderPage = (initialEntry: string | { pathname: string; state?: unknown }) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(browserSessionQueryKey, null);
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/login" element={<h1>Log in</h1>} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/verify-email" element={<VerifyEmailPage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
};

/** Lets a full suggestion delay pass with real timers, so a pending suggestion would have appeared. */
const waitPastSuggestionDelay = () => act(() => new Promise<void>((resolve) => {
  setTimeout(resolve, emailSuggestionDelayMilliseconds + 150);
}));

const suggestionButton = (email: string) => screen.queryByRole('button', { name: `Did you mean ${email}?` });

describe.each(emailRequestPages)('$name form', (page) => {
  test('shows an undeliverable domain on the field each time it is sent, and nothing as sent', async () => {
    const user = userEvent.setup();
    const { requests } = installEmailServer(page);
    renderPage(page.route);
    const input = await screen.findByLabelText('Email');
    const submit = await screen.findByRole('button', { name: page.submit });

    await user.type(input, 'lorem@nomail.invalid');
    await user.click(submit);

    expect(await screen.findByRole('alert')).toHaveTextContent(domainError);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription(domainError);
    expect(input).toHaveFocus();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByText(genericError)).not.toBeInTheDocument();

    // Sending the same address again is rejected again, and focus returns to the field.
    await user.click(submit);
    await waitFor(() => expect(requests).toEqual(['lorem@nomail.invalid', 'lorem@nomail.invalid']));
    expect(await screen.findByRole('alert')).toHaveTextContent(domainError);
    expect(input).toHaveFocus();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    // The error belongs to the rejected address: editing the field clears it.
    await user.clear(input);
    await user.type(input, 'lorem@example.test');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(input).not.toHaveAccessibleDescription();

    await user.click(submit);
    expect(await screen.findByRole('status')).toHaveTextContent(`${page.accepted} Sent to lorem@example.test`);

    // A resend to an accepted address reports it again.
    await user.click(submit);
    await waitFor(() => expect(requests).toHaveLength(4));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(`${page.accepted} Sent to lorem@example.test`));
    expect(requests.slice(2)).toEqual(['lorem@example.test', 'lorem@example.test']);
  });

  test('keeps the generic error for any other 422', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn(async (path: string) => (path === '/auth/browser/capabilities'
      ? jsonResponse(capabilities)
      : jsonResponse({ message: 'Enter a valid email address.' }, 422))));
    renderPage(page.route);
    const input = await screen.findByLabelText('Email');

    await user.type(input, 'lorem@example.test');
    await user.click(await screen.findByRole('button', { name: page.submit }));

    expect(await screen.findByRole('alert')).toHaveTextContent(genericError);
    expect(screen.queryByText(domainError)).not.toBeInTheDocument();
    expect(input).not.toHaveAttribute('aria-invalid');
  });

  test('shows the exact address it sent to, and starts over with a different email', async () => {
    const user = userEvent.setup();
    const { requests } = installEmailServer(page);
    renderPage(page.route);
    const input = await screen.findByLabelText('Email');

    await user.type(input, 'Lorem.Listener@Example.TEST');
    await user.click(await screen.findByRole('button', { name: page.submit }));

    // The address is shown as it was sent: trimmed and lowercased.
    expect(await screen.findByRole('status')).toHaveTextContent(`${page.accepted} Sent to lorem.listener@example.test`);
    expect(requests).toEqual(['lorem.listener@example.test']);

    await user.click(screen.getByRole('button', { name: 'Use a different email' }));

    expect(input).toHaveValue('');
    expect(input).toHaveFocus();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use a different email' })).not.toBeInTheDocument();

    await user.type(input, 'ipsum@example.test');
    await user.click(screen.getByRole('button', { name: page.submit }));
    expect(await screen.findByRole('status')).toHaveTextContent(`${page.accepted} Sent to ipsum@example.test`);
    expect(requests).toEqual(['lorem.listener@example.test', 'ipsum@example.test']);
  });

  test('suggests a fix for a mistyped provider domain and applies it only when selected', async () => {
    const user = userEvent.setup();
    const { requests } = installEmailServer(page);
    renderPage(page.route);
    const input = await screen.findByLabelText('Email');
    const region = input.parentElement?.querySelector('[aria-live="polite"]');
    // The polite live region exists, empty, before any suggestion, so assistive technology announces it.
    expect(region).toHaveAttribute('aria-atomic', 'true');
    expect(region).toBeEmptyDOMElement();

    await user.type(input, 'Lorem@gmial.com');
    const suggestion = await screen.findByRole('button', { name: 'Did you mean Lorem@gmail.com?' });
    expect(region).toContainElement(suggestion);
    // Nothing changes until the listener selects it.
    expect(input).toHaveValue('Lorem@gmial.com');

    await user.click(suggestion);

    expect(input).toHaveValue('Lorem@gmail.com');
    expect(input).toHaveFocus();
    expect(suggestionButton('Lorem@gmail.com')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: page.submit }));
    expect(await screen.findByRole('status')).toHaveTextContent('Sent to lorem@gmail.com');
    expect(requests).toEqual(['lorem@gmail.com']);
  });
});

test('a suggestion follows the typed domain, works from the keyboard, and never targets a known provider', async () => {
  const user = userEvent.setup();
  const { requests } = installEmailServer(emailRequestPages[0]);
  renderPage('/register');
  const input = await screen.findByLabelText('Email');

  await user.type(input, 'lorem@gmial.com');
  expect(await screen.findByRole('button', { name: 'Did you mean lorem@gmail.com?' })).toBeVisible();

  // A suggestion that no longer fits disappears at once; the next one waits for typing to pause.
  fireEvent.change(input, { target: { value: 'lorem@hotmial.com' } });
  expect(suggestionButton('lorem@gmail.com')).not.toBeInTheDocument();
  expect(suggestionButton('lorem@hotmail.com')).not.toBeInTheDocument();
  await screen.findByRole('button', { name: 'Did you mean lorem@hotmail.com?' });

  // Tab reaches the suggestion right after the field, and Enter applies it.
  input.focus();
  await user.tab();
  expect(suggestionButton('lorem@hotmail.com')).toHaveFocus();
  await user.keyboard('{Enter}');
  expect(input).toHaveValue('lorem@hotmail.com');
  expect(input).toHaveFocus();
  // Applying the suggestion does not submit the form.
  expect(requests).toEqual([]);

  await user.clear(input);
  await user.type(input, 'LOREM@GMAIL.COM');
  await waitPastSuggestionDelay();
  expect(screen.queryByRole('button', { name: /^Did you mean/ })).not.toBeInTheDocument();
});

test('a prefilled verification address with a mistyped domain is suggested at once', async () => {
  installEmailServer(emailRequestPages[1]);
  renderPage({ pathname: '/verify-email', state: { email: 'legacy@outlok.com' } });

  expect(screen.getByLabelText('Email')).toHaveValue('legacy@outlok.com');
  expect(screen.getByRole('button', { name: 'Did you mean legacy@outlook.com?' })).toBeVisible();
});

test('password recovery continues to the reset form with the address it sent to', async () => {
  const user = userEvent.setup();
  installEmailServer(emailRequestPages[2]);
  renderPage('/forgot-password');

  await user.type(screen.getByLabelText('Email'), 'Lorem@Example.test');
  await user.click(screen.getByRole('button', { name: 'Send reset code' }));
  await user.click(await screen.findByRole('button', { name: 'Enter reset code' }));

  expect(screen.getByLabelText('Email')).toHaveValue('lorem@example.test');
  expect(screen.getByLabelText('Reset code')).toBeInTheDocument();
});

test('a rejected recovery address offers no reset-code step', async () => {
  const user = userEvent.setup();
  installEmailServer(emailRequestPages[2]);
  renderPage('/forgot-password');

  await user.type(screen.getByLabelText('Email'), 'lorem@nomail.invalid');
  await user.click(screen.getByRole('button', { name: 'Send reset code' }));

  expect(await screen.findByRole('alert')).toHaveTextContent(domainError);
  expect(screen.queryByRole('button', { name: 'Enter reset code' })).not.toBeInTheDocument();
});
