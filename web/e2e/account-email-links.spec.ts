import type { Page } from '@playwright/test';

import type { BrowserSession } from '../src/api/schemas';
import { installEmailLinkAuth, type EmailLinkAuthFixture } from './support/emailLinkAuth';
import { installPrivateListenerRoutes } from './support/privateRoutes';
import { expect, test } from './support/test';

const newAccountId = 'e2e-email-link-listener';
const newEmail = 'lorem-listener@example.test';
const newPassword = 'lorem ipsum dolor sit amet';
const legacyPassword = 'consectetur adipiscing elit';

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

test('registers a new account through the emailed link and logs in with it', async ({ page, baseURL }) => {
  const auth = await installAccountJourney(page, baseURL, sessionFor(newAccountId, newEmail, 'Lorem Listener'));

  await page.goto('/finitude/register');
  await expect(page.getByRole('heading', { level: 1, name: 'Make your Library yours.' })).toBeVisible();
  await expect(page.getByLabel('Password')).toHaveCount(0);
  await page.getByLabel('Email').fill(newEmail);
  await page.getByRole('button', { name: 'Send link' }).click();
  const sentStatus = page.getByRole('status').filter({ hasText: 'Check your email.' });
  await expect(sentStatus).toHaveText(
    'Check your email. We sent a message to this address with the next step. Registration links expire after 30 minutes.'
  );

  // An address that already has an account sees exactly the same page; only the email differs.
  await page.getByLabel('Email').fill(verifiedSession.user.email);
  await page.getByRole('button', { name: 'Send link' }).click();
  await expect(sentStatus).toHaveText(/^Check your email\./);
  expect(auth.outbox.map(({ to, subject }) => ({ to, subject }))).toEqual([
    { to: newEmail, subject: 'Finish creating your Finitude account' },
    { to: verifiedSession.user.email, subject: 'You already have a Finitude account' }
  ]);
  expect(auth.outbox[1].text).not.toContain('#token=');

  const link = auth.latestLink(newEmail, 'registration');
  await page.goto(link);
  await expect(page.getByRole('heading', { level: 1, name: 'Set up your listener account.' })).toBeVisible();
  await expect(page).toHaveURL(/\/finitude\/register\/complete$/);
  expect(await page.evaluate(() => window.location.hash)).toBe('');
  await expect(page.getByLabel('Email')).toHaveValue(newEmail);
  await page.getByLabel('Display name').fill('Lorem Listener');
  await page.getByLabel('Password', { exact: true }).fill(newPassword);
  await page.getByLabel('Confirm password').fill(newPassword);
  await page.getByRole('button', { name: 'Create account' }).click();

  await expect(page).toHaveURL(/\/finitude\/login$/);
  await expect(page.getByRole('status').filter({ hasText: 'Your account is ready.' })).toHaveText(
    'Your account is ready. Log in with your email and new password here or in the Finitude app.'
  );
  await expect(page.getByLabel('Email or username')).toHaveValue(newEmail);
  const completion = auth.requests.find(({ path }) => path === '/auth/browser/registration/complete');
  expect(completion?.body).toEqual({ token: link.split('#token=')[1], password: newPassword, displayName: 'Lorem Listener' });
  expect(auth.accountState(newEmail)).toBe('verified');

  await logIn(page, newPassword);
  await expect(page).toHaveURL(/\/finitude$/);
  await expect(page.getByRole('heading', { name: 'Browser Test Listening Room' })).toBeVisible();

  // The link worked once.
  await page.goto(link);
  await expect(page.getByRole('heading', { level: 1, name: 'This link can’t be used' })).toBeVisible();
  expectCleanContract(auth);
});

test('an expired registration link offers a new link that works', async ({ page, baseURL }) => {
  const auth = await installAccountJourney(page, baseURL, sessionFor(newAccountId, newEmail, 'Lorem Listener'));

  await page.goto('/finitude/register');
  await page.getByLabel('Email').fill(newEmail);
  await page.getByRole('button', { name: 'Send link' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Check your email.' })).toBeVisible();
  const expired = auth.latestLink(newEmail, 'registration');
  auth.expireLinks();

  await page.goto(expired);
  await expect(page.getByRole('heading', { level: 1, name: 'This link can’t be used' })).toBeVisible();
  await expect(page.getByText('This link is invalid, has expired, or was already used. Request a new link to continue.')).toBeVisible();
  await expect(page.getByLabel('Display name')).toHaveCount(0);
  expect(await page.evaluate(() => window.location.hash)).toBe('');

  await page.getByRole('link', { name: 'Request a new link' }).click();
  await expect(page).toHaveURL(/\/finitude\/register$/);
  await page.getByLabel('Email').fill(newEmail);
  await page.getByRole('button', { name: 'Send link' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Check your email.' })).toBeVisible();
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
    { to: legacySession.user.email, subject: 'Verify your Finitude email' }
  ]);

  // The listener can ask for another link from the same message.
  await page.getByRole('link', { name: 'Didn’t get the email? Send a new verification link' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Get a verification link.' })).toBeVisible();
  await expect(page.getByLabel('Email')).toHaveValue(legacySession.user.email);
  await page.getByRole('button', { name: 'Send verification link' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'If this address needs verification' })).toHaveText(
    'If this address needs verification, we sent a link. Check your email.'
  );
  expect(auth.outbox).toHaveLength(2);

  await page.goto(auth.latestLink(legacySession.user.email, 'verifyEmail'));
  await expect(page.getByRole('heading', { level: 1, name: 'Confirm this email is yours.' })).toBeVisible();
  await expect(page.getByText('Your password doesn’t change.', { exact: false })).toBeVisible();
  await expect(page.getByLabel('Email')).toHaveValue(legacySession.user.email);
  expect(await page.evaluate(() => window.location.hash)).toBe('');
  // Opening the page must not verify the address; only the explicit click does.
  expect(auth.requests.filter(({ path }) => path === '/auth/browser/email-verification/confirm')).toEqual([]);
  expect(auth.accountState(legacySession.user.email)).toBe('legacy_unverified');

  await page.getByRole('button', { name: 'Verify email' }).click();
  await expect(page).toHaveURL(/\/finitude\/login$/);
  await expect(page.getByRole('status').filter({ hasText: 'Email verified.' })).toHaveText('Email verified. You can now log in.');
  await expect(page.getByLabel('Email or username')).toHaveValue(legacySession.user.email);
  expect(auth.accountState(legacySession.user.email)).toBe('verified');

  await logIn(page, legacyPassword);
  await expect(page).toHaveURL(/\/finitude$/);
  await expect(page.getByRole('heading', { name: 'Browser Test Listening Room' })).toBeVisible();
  expectCleanContract(auth);
});

test('an expired verification link offers a new link instead of verifying', async ({ page, baseURL }) => {
  const auth = await installAccountJourney(page, baseURL, sessionFor(newAccountId, newEmail, 'Lorem Listener'));

  await page.goto('/finitude/verify-email');
  await page.getByLabel('Email').fill(legacySession.user.email);
  await page.getByRole('button', { name: 'Send verification link' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'If this address needs verification' })).toBeVisible();
  const link = auth.latestLink(legacySession.user.email, 'verifyEmail');
  auth.expireLinks();

  await page.goto(link);
  await expect(page.getByRole('heading', { level: 1, name: 'This link can’t be used' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Verify email' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send verification link' })).toBeVisible();
  expect(auth.accountState(legacySession.user.email)).toBe('legacy_unverified');
  expectCleanContract(auth);
});
