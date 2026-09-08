import type { Route } from '@playwright/test';

import { privateViewerSession } from './fixtures/privateListener';
import { installPrivateListenerRoutes } from './support/privateRoutes';
import { installSignedOutApi } from './support/apiRoutes';
import { expect, test } from './support/test';

const viewer = privateViewerSession.user.id;
const json = (route: Route, body: unknown, status = 200, owner = viewer) => route.fulfill({
  status, contentType: 'application/json',
  headers: { 'Cache-Control': 'no-store', 'X-Finitude-Account-Viewer': owner },
  body: JSON.stringify(body)
});
const empty = (route: Route) => route.fulfill({
  status: 204, headers: { 'X-Finitude-Account-Viewer': viewer }, body: ''
});

for (const [trigger, confirmation, endpoint] of [
  ['Sign out everywhere', 'Confirm sign out everywhere', '/auth/logout-all'],
  ['Delete account', 'Delete account permanently', '/auth/account']
]) {
  test(`${trigger} refreshes an expired cookie without taking a nested browser lock`, async ({ page }) => {
    await installPrivateListenerRoutes(page);
    let expired = false;
    let signedOut = false;
    const requests: string[] = [];
    await page.route('**/auth/browser/session', (route) => json(
      route, expired || signedOut ? {} : privateViewerSession, expired || signedOut ? 401 : 200
    ));
    await page.route(`**${endpoint}`, (route) => {
      requests.push(endpoint);
      return expired ? json(route, {}, 401) : empty(route);
    });
    await page.route('**/auth/browser/refresh', (route) => {
      requests.push('/auth/browser/refresh');
      expect(route.request().headers()['x-finitude-session-transition']).toBe('web-locks-v1');
      expect(route.request().headers()['x-finitude-account-viewer']).toBe(viewer);
      expired = false;
      return json(route, privateViewerSession);
    });
    await page.route('**/auth/browser/logout', (route) => {
      requests.push('/auth/browser/logout');
      signedOut = true;
      return empty(route);
    });

    await page.goto('/finitude/account');
    await expect(page.getByRole('button', { name: trigger })).toBeVisible();
    expired = true;
    await page.getByRole('button', { name: trigger }).click();
    await page.getByRole('button', { name: confirmation }).click();
    await expect(page).toHaveURL(/\/finitude$/);
    expect(requests).toEqual([endpoint, '/auth/browser/refresh', endpoint, '/auth/browser/logout']);
    expect(await page.evaluate(() => navigator.locks.request(
      'finitude:browser-session-transition', { ifAvailable: true }, (lock) => lock !== null
    ))).toBe(true);
  });
}

test('a delayed old-account 401 cannot sign out the account installed by another tab', async ({ page, context }) => {
  await installPrivateListenerRoutes(page);
  const replacement = { user: {
    ...privateViewerSession.user, id: 'replacement-viewer', displayName: 'Replacement Listener',
    email: 'replacement@example.test'
  } };
  let replaced = false;
  let historyStarted = false;
  let releaseHistory!: () => void;
  const historyGate = new Promise<void>((resolve) => { releaseHistory = resolve; });
  let cookieWrites = 0;
  await page.route('**/api/listener/v1/capabilities', (route) => json(route, { playlists: false }));
  await page.route('**/auth/browser/session', (route) => json(route, replaced ? replacement : privateViewerSession));
  await page.route('**/auth/activity/listening-history', async (route) => {
    expect(route.request().headers()['x-finitude-account-viewer']).toBe(viewer);
    historyStarted = true;
    await historyGate;
    await json(route, {}, 401);
  });
  await page.route('**/auth/browser/{logout,refresh}', async (route) => {
    cookieWrites += 1;
    await empty(route);
  });

  const otherTab = await context.newPage();
  const otherApi = await installSignedOutApi(otherTab);
  await installPrivateListenerRoutes(otherTab, { session: replacement });
  await otherTab.route('**/auth/browser/session', (route) => json(route, replaced ? replacement : {}, replaced ? 200 : 401));
  await otherTab.route('**/auth/browser/login', (route) => {
    replaced = true;
    return json(route, replacement);
  });
  try {
    await page.goto('/finitude/account');
    await page.getByRole('button', { name: 'Clear listening history' }).click();
    await page.getByRole('button', { name: 'Clear history', exact: true }).click();
    await expect.poll(() => historyStarted).toBe(true);

    await otherTab.goto('/finitude/login');
    await otherTab.getByLabel('Email or username').fill('replacement@example.test');
    await otherTab.getByLabel('Password', { exact: true }).fill('synthetic test password');
    await otherTab.getByRole('button', { name: 'Log in', exact: true }).click();
    await expect(otherTab).toHaveURL(/\/finitude$/);
    await expect(page.getByRole('link', { name: 'Replacement Listener', exact: true })).toBeVisible();

    const finished = page.waitForResponse((response) => new URL(response.url()).pathname === '/auth/activity/listening-history');
    releaseHistory();
    await finished;
    // Acquiring the same lock drains any recovery queued by the delayed response.
    await page.evaluate(() => navigator.locks.request('finitude:browser-session-transition', async () => undefined));
    await expect(page.getByRole('link', { name: 'Replacement Listener', exact: true })).toBeVisible();
    expect(cookieWrites).toBe(0);
    expect(otherApi.unhandled).toEqual([]);
  } finally {
    releaseHistory();
    await otherTab.close();
  }
});
