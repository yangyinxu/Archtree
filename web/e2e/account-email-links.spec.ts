import type { Page } from '@playwright/test';

import type { BrowserSession } from '../src/api/schemas';
import { expectNoUnownedAxeViolations } from './support/accessibility';
import { installEmailLinkAuth, type EmailLinkAuthFixture } from './support/emailLinkAuth';
import { installPrivateListenerRoutes } from './support/privateRoutes';
import { expect, test } from './support/test';

const newAccountId = 'e2e-email-link-listener';
const newEmail = 'lorem-listener@example.test';
const newPassword = 'lorem ipsum dolor sit amet';
const legacyPassword = 'consectetur adipiscing elit';
/** `.invalid` is reserved, so the fake account server treats this domain as unable to receive mail. */
const undeliverableEmail = 'lorem-listener@nomail.invalid';
const domainError = 'This email domain can’t receive mail. Check the spelling and try again.';

const sessionFor = (id: string, email: string, displayName: string, emailVerified = true) => ({
  user: {
    id,
    email,
    role: 'user',
    displayName,
    avatarRevision: 0,
    avatar: null,
    emailVerified,
    authenticationMethods: ['password']
  }
}) satisfies BrowserSession;

const legacySession = sessionFor('e2e-legacy-listener', 'legacy-listener@example.test', 'Ipsum Listener', false);
const verifiedSession = sessionFor('e2e-verified-listener', 'dolor-listener@example.test', 'Dolor Listener');

/** Serves the signed-in Home for `session` while the fake account server decides who is signed in. */
const installAccountJourney = async (page: Page, baseURL: string | undefined, session: BrowserSession) => {
  await installPrivateListenerRoutes(page, { session });
  const auth = await installEmailLinkAuth(page, new URL(baseURL ?? 'http://127.0.0.1:4173').origin, newAccountId);
  auth.addAccount({ session: legacySession, password: legacyPassword, state: 'legacy_unverified' });
  auth.addAccount({ session: verifiedSession, password: 'sed do eiusmod tempor', state: 'verified' });
  return auth;
};

const expectCleanContract = (auth: EmailLinkAuthFixture) => {
  expect(auth.violations).toEqual([]);
  const tokens = auth.outbox.flatMap(({ text }) => [...text.matchAll(/#token=([A-Za-z0-9_-]{43})/g)].map((match) => match[1]));
  for (const token of tokens) {
    expect(auth.requestUrls.filter((url) => url.includes(token))).toEqual([]);
  }
};

const logIn = async (page: Page, password: string) => {
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
};

test('registers a Kashewt account through the emailed link and logs in with it', async ({ page, baseURL }) => {
  const auth = await installAccountJourney(page, baseURL, sessionFor(newAccountId, newEmail, 'Lorem Listener'));

  await page.goto('/account/register');
  await expect(page.getByRole('heading', { level: 1, name: 'Create a Kashewt account.' })).toBeVisible();
  await expect(page.getByLabel('Password')).toHaveCount(0);
  await page.getByLabel('Email').fill(newEmail);
  await page.getByRole('button', { name: 'Send link' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Check your email.' })).toBeVisible();
  await expect(page.getByText(newEmail, { exact: true })).toBeVisible();

  // An address that already has an account sees exactly the same page; only the email differs.
  await page.getByRole('button', { name: 'Use a different email' }).click();
  await expect(page.getByLabel('Email')).toBeFocused();
  await expect(page.getByLabel('Email')).toHaveValue('');
  await page.getByLabel('Email').fill(verifiedSession.user.email);
  await page.getByRole('button', { name: 'Send link' }).click();
  await expect(page.getByText(verifiedSession.user.email, { exact: true })).toBeVisible();
  expect(auth.outbox.map(({ to, subject }) => ({ to, subject }))).toEqual([
    { to: newEmail, subject: 'Finish creating your Kashewt account' },
    { to: verifiedSession.user.email, subject: 'You already have a Kashewt account' }
  ]);
  expect(auth.outbox[1].text).not.toContain('#token=');

  const link = auth.latestLink(newEmail, 'registration');
  await page.goto(link);
  await expect(page.getByRole('heading', { level: 1, name: 'Set up your Kashewt account.' })).toBeVisible();
  await expect(page).toHaveURL(/\/account\/register\/complete$/);
  expect(await page.evaluate(() => window.location.hash)).toBe('');
  await expect(page.getByLabel('Email')).toHaveValue(newEmail);
  await page.getByLabel('Display name').fill('Lorem Listener');
  await page.getByLabel('Password', { exact: true }).fill(newPassword);
  await page.getByLabel('Confirm password').fill(newPassword);
  await page.getByRole('button', { name: 'Create account' }).click();

  await expect(page).toHaveURL(/\/auth\/login-web\?notice=registered$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Log in to Kashewt.' })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('Your account is ready. Log in with your email and new password.');
  const completion = auth.requests.find(({ path }) => path === '/auth/browser/registration/complete');
  expect(completion?.body).toEqual({ token: link.split('#token=')[1], password: newPassword, displayName: 'Lorem Listener' });
  expect(auth.accountState(newEmail)).toBe('verified');

  await page.getByLabel('Email or username').fill(newEmail);
  await logIn(page, newPassword);
  await expect(page).toHaveURL(/\/$/);

  // The link worked once.
  await page.goto(link);
  await expect(page.getByRole('heading', { level: 1, name: 'This link can’t be used.' })).toBeVisible();
  expectCleanContract(auth);
});

test('an expired registration link offers a new link that works', async ({ page, baseURL }) => {
  const auth = await installAccountJourney(page, baseURL, sessionFor(newAccountId, newEmail, 'Lorem Listener'));

  await page.goto('/account/register');
  await page.getByLabel('Email').fill(newEmail);
  await page.getByRole('button', { name: 'Send link' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Check your email.' })).toBeVisible();
  const expired = auth.latestLink(newEmail, 'registration');
  auth.expireLinks();

  await page.goto(expired);
  await expect(page.getByRole('heading', { level: 1, name: 'This link can’t be used.' })).toBeVisible();
  await expect(page.getByText('It’s invalid, has expired, or was already used. Request a new link to continue.')).toBeVisible();
  await expect(page.getByLabel('Display name')).toBeHidden();
  expect(await page.evaluate(() => window.location.hash)).toBe('');

  await page.getByRole('link', { name: 'Request a new link' }).click();
  await expect(page).toHaveURL(/\/account\/register$/);
  await page.getByLabel('Email').fill(newEmail);
  await page.getByRole('button', { name: 'Send link' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Check your email.' })).toBeVisible();
  const fresh = auth.latestLink(newEmail, 'registration');
  expect(fresh).not.toBe(expired);

  await page.goto(fresh);
  await expect(page.getByLabel('Display name')).toBeVisible();
  await expect(page.getByLabel('Email')).toHaveValue(newEmail);
  expectCleanContract(auth);
});

test('a legacy account verifies its email from the link, then logs in', async ({ page, baseURL }) => {
  const auth = await installAccountJourney(page, baseURL, { user: { ...legacySession.user, emailVerified: true } });

  await page.goto('/finitude/login');
  await page.getByLabel('Email or username').fill(legacySession.user.email);
  await logIn(page, legacyPassword);
  await expect(page.getByRole('alert')).toHaveText(
    'Verify your email to log in. We sent a verification link to your email address. Open it, then log in again.'
  );
  expect(auth.outbox.map(({ to, subject }) => ({ to, subject }))).toEqual([
    { to: legacySession.user.email, subject: 'Verify your Kashewt email' }
  ]);

  await page.goto(auth.latestLink(legacySession.user.email, 'verifyEmail'));
  await expect(page.getByRole('heading', { level: 1, name: 'Confirm this email is yours.' })).toBeVisible();
  await expect(page.getByText('Your password doesn’t change.', { exact: false })).toBeVisible();
  await expect(page.locator('#verify-confirm-email')).toHaveValue(legacySession.user.email);
  expect(await page.evaluate(() => window.location.hash)).toBe('');
  // Opening the page must not verify the address; only the explicit click does.
  expect(auth.requests.filter(({ path }) => path === '/auth/browser/email-verification/confirm')).toEqual([]);
  expect(auth.accountState(legacySession.user.email)).toBe('legacy_unverified');

  await page.getByRole('button', { name: 'Verify email' }).click();
  await expect(page).toHaveURL(/\/auth\/login-web\?notice=verified$/);
  await expect(page.getByRole('status')).toHaveText('Email verified. You can now log in.');
  expect(auth.accountState(legacySession.user.email)).toBe('verified');

  await page.getByLabel('Email or username').fill(legacySession.user.email);
  await logIn(page, legacyPassword);
  await expect(page).toHaveURL(/\/$/);
  expectCleanContract(auth);
});

test('an expired verification link offers a new link instead of verifying', async ({ page, baseURL }) => {
  const auth = await installAccountJourney(page, baseURL, sessionFor(newAccountId, newEmail, 'Lorem Listener'));

  await page.goto('/account/verify-email');
  await expect(page.getByRole('heading', { level: 1, name: 'Get a verification link.' })).toBeVisible();
  await page.locator('#verify-email').fill(legacySession.user.email);
  await page.getByRole('button', { name: 'Send verification link' }).click();
  await expect(page.getByRole('status')).toHaveText('If this address needs verification, we sent a link. Check your email.');
  const link = auth.latestLink(legacySession.user.email, 'verifyEmail');
  auth.expireLinks();

  await page.goto(link);
  await expect(page.getByRole('heading', { level: 1, name: 'This link can’t be used.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Verify email' })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Send verification link' })).toBeVisible();
  expect(auth.accountState(legacySession.user.email)).toBe('legacy_unverified');
  expectCleanContract(auth);
});

test('resets a password with the emailed code, then logs in with the new one', async ({ page, baseURL }) => {
  const auth = await installAccountJourney(page, baseURL, verifiedSession);
  const replacement = 'ut labore et dolore magna';

  await page.goto('/auth/login-web');
  await page.getByRole('link', { name: 'Forgot password?' }).click();
  await expect(page).toHaveURL(/\/account\/forgot-password$/);
  await page.getByLabel('Email').fill(verifiedSession.user.email);
  await page.getByRole('button', { name: 'Send reset code' }).click();
  await expect(page.getByRole('status')).toHaveText('If this address can reset a password, we sent a recovery email with a six-digit code.');
  expect(auth.outbox.map(({ subject }) => subject)).toEqual(['Reset your Kashewt password']);

  await page.getByRole('link', { name: 'Enter reset code' }).click();
  await expect(page).toHaveURL(/\/account\/reset-password$/);
  await expect(page.getByLabel('Email')).toHaveValue(verifiedSession.user.email);
  const resetCode = auth.latestResetCode(verifiedSession.user.email);
  await page.getByLabel('Reset code').fill(resetCode === '000000' ? '111111' : '000000');
  await page.getByLabel('New password', { exact: true }).fill(replacement);
  await page.getByLabel('Confirm new password').fill(replacement);
  await page.getByRole('button', { name: 'Reset password' }).click();
  await expect(page.getByRole('alert')).toHaveText('That reset code is invalid or has expired. Request another code.');

  await page.getByLabel('Reset code').fill(resetCode);
  await page.getByRole('button', { name: 'Reset password' }).click();
  await expect(page).toHaveURL(/\/auth\/login-web\?notice=password_reset$/);
  await expect(page.getByRole('status')).toHaveText('Password reset. Log in again with your new password.');

  await page.getByLabel('Email or username').fill(verifiedSession.user.email);
  await logIn(page, replacement);
  await expect(page).toHaveURL(/\/$/);
  expectCleanContract(auth);
});

test('the Kashewt sign-up marks an undeliverable domain on the email field and mails nothing', async ({ page, baseURL }) => {
  const auth = await installAccountJourney(page, baseURL, sessionFor(newAccountId, newEmail, 'Lorem Listener'));

  await page.goto('/account/register');
  const email = page.getByLabel('Email');
  await email.fill(undeliverableEmail);
  await page.getByRole('button', { name: 'Send link' }).click();
  await expect(page.getByRole('alert')).toHaveText(domainError);
  await expect(email).toHaveAttribute('aria-invalid', 'true');
  await expect(email).toHaveAccessibleDescription(domainError);
  await expect(email).toBeFocused();
  await expectNoUnownedAxeViolations(page, 'kashewt-register-undeliverable-domain');
  expect(auth.outbox).toEqual([]);

  await email.fill(newEmail);
  await page.getByRole('button', { name: 'Send link' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Check your email.' })).toBeVisible();
  await expectNoUnownedAxeViolations(page, 'kashewt-register-link-sent');
  expectCleanContract(auth);
});

test('an undeliverable domain is flagged on the field on every resend, and nothing is mailed to it', async ({ page, baseURL }) => {
  const auth = await installAccountJourney(page, baseURL, sessionFor(newAccountId, newEmail, 'Lorem Listener'));
  const registrationRequests = () => auth.requests.filter(({ path }) => path === '/auth/browser/registration/request');

  await page.goto('/finitude/register');
  const email = page.getByLabel('Email');
  const send = page.getByRole('button', { name: 'Send link' });
  const sentStatus = page.getByRole('status').filter({ hasText: 'Check your email.' });
  await email.fill(undeliverableEmail);
  await send.click();
  await expect(page.getByRole('alert')).toHaveText(domainError);
  await expect(email).toHaveAttribute('aria-invalid', 'true');
  await expect(email).toHaveAccessibleDescription(domainError);
  await expect(email).toBeFocused();
  await expect(sentStatus).toHaveCount(0);
  await expectNoUnownedAxeViolations(page, 'register-undeliverable-domain');

  // Sending the same address again is rejected again, and still nothing is mailed.
  await send.click();
  await expect.poll(() => registrationRequests().length).toBe(2);
  await expect(page.getByRole('alert')).toHaveText(domainError);
  await expect(email).toBeFocused();
  expect(auth.outbox).toEqual([]);

  // A corrected address goes through, shows where it went, and can be sent again.
  await email.fill(newEmail);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(email).not.toHaveAttribute('aria-invalid');
  await send.click();
  await expect(sentStatus).toContainText(`Sent to ${newEmail}`);
  await send.click();
  await expect.poll(() => auth.outbox.length).toBe(2);
  await expect(sentStatus).toContainText(`Sent to ${newEmail}`);
  await expectNoUnownedAxeViolations(page, 'register-link-sent');

  await page.getByRole('button', { name: 'Use a different email' }).click();
  await expect(email).toHaveValue('');
  await expect(email).toBeFocused();
  await expect(sentStatus).toHaveCount(0);

  // The verification-link and password-recovery requests reject the address the same way.
  for (const [path, action] of [
    ['/finitude/verify-email', 'Send verification link'],
    ['/finitude/forgot-password', 'Send reset code']
  ] as const) {
    await page.goto(path);
    await page.getByLabel('Email').fill(undeliverableEmail);
    await page.getByRole('button', { name: action }).click();
    await expect(page.getByRole('alert')).toHaveText(domainError);
    await expect(page.getByRole('status').filter({ hasText: 'Sent to' })).toHaveCount(0);
  }
  await expect(page.getByRole('button', { name: 'Enter reset code' })).toHaveCount(0);

  expect(auth.outbox.map(({ to, subject }) => ({ to, subject }))).toEqual([
    { to: newEmail, subject: 'Finish creating your Kashewt account' },
    { to: newEmail, subject: 'Finish creating your Kashewt account' }
  ]);
  expect(auth.requests
    .filter(({ body }) => (body as { email?: unknown }).email === undeliverableEmail)
    .map(({ path }) => path)).toEqual([
    '/auth/browser/registration/request',
    '/auth/browser/registration/request',
    '/auth/browser/email-verification/request',
    '/auth/browser/password/forgot'
  ]);
  expectCleanContract(auth);
});

test('a mistyped provider domain is suggested while typing and applied before the link is sent', async ({ page, baseURL }) => {
  const auth = await installAccountJourney(page, baseURL, sessionFor(newAccountId, newEmail, 'Lorem Listener'));

  await page.goto('/finitude/register');
  const email = page.getByLabel('Email');
  await email.pressSequentially('Lorem-Listener@gmial.com');
  const suggestion = page.getByRole('button', { name: 'Did you mean Lorem-Listener@gmail.com?' });
  await expect(suggestion).toBeVisible();
  // Nothing changes until the listener selects it.
  await expect(email).toHaveValue('Lorem-Listener@gmial.com');
  await expectNoUnownedAxeViolations(page, 'register-email-suggestion');

  // Tab reaches the suggestion right after the field; Enter applies it without sending.
  await email.focus();
  await page.keyboard.press('Tab');
  await expect(suggestion).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(email).toHaveValue('Lorem-Listener@gmail.com');
  await expect(email).toBeFocused();
  await expect(suggestion).toHaveCount(0);
  expect(auth.requests).toEqual([]);

  await page.keyboard.press('Enter');
  await expect(page.getByRole('status').filter({ hasText: 'Check your email.' }))
    .toContainText('Sent to lorem-listener@gmail.com');
  expect(auth.outbox.map(({ to }) => to)).toEqual(['lorem-listener@gmail.com']);
  expectCleanContract(auth);
});

test('Kashewt sign-up suggests a mistyped provider domain and applies it only when selected', async ({ page, baseURL }) => {
  const auth = await installAccountJourney(page, baseURL, sessionFor(newAccountId, newEmail, 'Lorem Listener'));

  await page.goto('/account/register');
  const email = page.getByLabel('Email');
  await email.pressSequentially('Lorem-Listener@gmial.com');
  const suggestion = page.getByRole('button', { name: 'Did you mean Lorem-Listener@gmail.com?' });
  await expect(suggestion).toBeVisible();
  await expect(email).toHaveValue('Lorem-Listener@gmial.com');

  await email.focus();
  await page.keyboard.press('Tab');
  await expect(suggestion).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(email).toHaveValue('Lorem-Listener@gmail.com');
  await expect(email).toBeFocused();
  await expect(suggestion).toBeHidden();
  expect(auth.requests).toEqual([]);

  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: 'Check your email.' })).toBeVisible();
  expect(auth.outbox.map(({ to }) => to)).toEqual(['lorem-listener@gmail.com']);
  expectCleanContract(auth);
});
