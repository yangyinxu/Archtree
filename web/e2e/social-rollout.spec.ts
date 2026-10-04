import type { Page, Route } from '@playwright/test';

import { albumFixture, catalogIds } from './fixtures/catalog';
import { privateViewerSession } from './fixtures/privateListener';
import { installPrivateListenerRoutes } from './support/privateRoutes';
import { expect, test } from './support/test';

interface SocialRollout { enabled: boolean; rooms: boolean }

const viewer = privateViewerSession.user.id;
const audioTitle = 'Night Window';
const unavailable = 'Together is temporarily unavailable. Removing friends, blocking and deactivating your profile still work.';
const friend = { socialId: `s_${'b'.repeat(32)}`, handle: 'bobby', alias: 'Bob', iconSeed: 'bob' };

const json = (route: Route, payload: unknown, status = 200) => route.fulfill({
  status,
  contentType: 'application/json; charset=utf-8',
  headers: { 'Cache-Control': 'private, no-store', 'X-Finitude-Account-Viewer': viewer },
  body: JSON.stringify(payload)
});

/** Overrides the public rollout switches after the strict fixture, which defaults to a social-enabled deployment. */
const installRollout = async (page: Page, rollout: () => SocialRollout) => {
  const reads: SocialRollout[] = [];
  await page.route('**/api/listener/v1/capabilities', (route) => {
    const social = rollout();
    reads.push(social);
    return json(route, { playlists: true, social });
  });
  return reads;
};

/** Collects social API traffic so a disabled launch can prove it never contacts the social backend. */
const recordSocialRequests = (page: Page) => {
  const paths: string[] = [];
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.startsWith('/api/social/')) paths.push(pathname);
  });
  return paths;
};

const shellReady = async (page: Page) => {
  await expect(page.getByRole('heading', { name: 'Browser Test Listening Room' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'MediaTracks for focus' })).toBeVisible();
  await expect(page.getByRole('main').getByRole('button', { name: `Play ${audioTitle}` })).toBeVisible();
};

const expectNoSocialEntryPoints = async (page: Page) => {
  // Any deferred action chunk the page requested has settled before absence is asserted.
  await page.waitForLoadState('networkidle');
  await expect(page.locator('nav[aria-label="Primary"] a[href$="/social"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Share / })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Listen together:/ })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /^Room invitations/ })).toHaveCount(0);
};

test.describe('social rollout gating', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1_280, height: 800 });
  });

  test('the default social-enabled fixture offers every entry point', async ({ page }) => {
    await page.goto('/finitude');
    await shellReady(page);
    await expect(page.locator('nav[aria-label="Primary"] a[href$="/social"]')).toHaveCount(2);
    await expect(page.getByRole('button', { name: `Share ${albumFixture.title}` })).toBeVisible();
    await expect(page.getByRole('button', { name: `Share ${audioTitle}` })).toBeVisible();
    await expect(page.getByRole('button', { name: `Listen together: ${audioTitle}` })).toBeVisible();
  });

  test('flags off: signed-out visitors see no social entry point on Home, Album or the player', async ({ page }) => {
    const reads = await installRollout(page, () => ({ enabled: false, rooms: false }));
    await page.goto('/finitude');
    await shellReady(page);
    expect(reads.length).toBeGreaterThan(0);
    await expectNoSocialEntryPoints(page);

    await page.getByRole('main').getByRole('button', { name: `Play ${audioTitle}` }).click();
    const player = page.getByRole('region', { name: 'Now playing' });
    await expect(player).toContainText(audioTitle);
    await expect(player.getByRole('button', { name: /^Listen together:/ })).toHaveCount(0);

    await page.goto(`/finitude/albums/${catalogIds.album}`);
    await expect(page.getByRole('heading', { level: 1, name: albumFixture.title })).toBeVisible();
    await expect(page.getByRole('main').getByRole('button', { name: `Play ${audioTitle}` })).toBeVisible();
    await expectNoSocialEntryPoints(page);
  });

  test('flags off: a signed-in listener never contacts the social backend and Together explains itself', async ({ page }) => {
    await installPrivateListenerRoutes(page);
    await installRollout(page, () => ({ enabled: false, rooms: false }));
    await page.route('**/api/social/v1/relationships?*', (route) => json(route, { items: [], nextCursor: null }));
    const socialRequests = recordSocialRequests(page);
    await page.goto('/finitude');
    await shellReady(page);
    await expect(page.getByRole('link', { name: privateViewerSession.user.displayName, exact: true })).toBeVisible();
    await expectNoSocialEntryPoints(page);
    // No reminder, active-room entry, listening publisher or capability poll runs while social is off.
    expect(socialRequests).toEqual([]);

    // The route is no longer advertised but stays reachable for the preserved reads and safety actions.
    await page.goto('/finitude/social');
    await expect(page.getByText(unavailable)).toBeVisible();
    await expect(page.locator('nav[aria-label="Primary"] a[href$="/social"]')).toHaveCount(0);
  });

  test('social without rooms keeps Share but hides Listen together', async ({ page }) => {
    await installRollout(page, () => ({ enabled: true, rooms: false }));
    await page.goto('/finitude');
    await shellReady(page);
    await expect(page.locator('nav[aria-label="Primary"] a[href$="/social"]')).toHaveCount(2);
    await expect(page.getByRole('button', { name: `Share ${audioTitle}` })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Listen together:/ })).toHaveCount(0);
  });

  test('a share refused by a disabled rollout is explained and the social entry points disappear', async ({ page }) => {
    let rollout: SocialRollout = { enabled: true, rooms: false };
    await installPrivateListenerRoutes(page);
    const reads = await installRollout(page, () => rollout);
    const shares: unknown[] = [];
    await page.route('**/api/social/v1/me/profile', (route) => json(route, { profile: {
      socialId: `s_${'a'.repeat(32)}`, handle: 'alice', alias: 'Alice', iconSeed: 'alice', active: true, discoverable: true, revision: 1
    } }));
    await page.route('**/api/social/v1/capabilities', (route) => json(route, {
      socialEnabled: rollout.enabled, roomsEnabled: rollout.rooms
    }));
    await page.route('**/api/social/v1/rooms/current', (route) => json(route, { room: null }));
    await page.route('**/api/social/v1/me/listening', (route) => json(route, { listening: {
      enabled: false, revision: 0, publisherRevision: 0, serverTimeMs: Date.now()
    } }));
    await page.route('**/api/social/v1/relationships?*', (route) => json(route, {
      items: [{ socialId: friend.socialId, revision: 3, profile: friend }], nextCursor: null
    }));
    await page.route('**/api/social/v1/mutation-scopes', (route) => json(route, {
      scopeToken: 'synthetic-social-rollout-scope-token', expiresAt: new Date(Date.now() + 60_000).toISOString()
    }));
    await page.route('**/api/social/v1/music-shares', (route) => {
      shares.push(route.request().postDataJSON());
      // The server switch was turned off after this page loaded.
      rollout = { enabled: false, rooms: false };
      return json(route, { code: 'social_disabled', message: 'Social participation is disabled.' }, 503);
    });

    await page.goto('/finitude');
    await shellReady(page);
    await expect(page.locator('nav[aria-label="Primary"] a[href$="/social"]')).toHaveCount(2);
    await page.getByRole('button', { name: `Share ${audioTitle}` }).click();
    const dialog = page.getByRole('dialog', { name: `Share ${audioTitle}` });
    await dialog.getByRole('combobox', { name: 'Choose a friend' }).selectOption(friend.socialId);
    const readsBeforeSend = reads.length;
    await dialog.getByRole('button', { name: 'Send share' }).click();

    await expect(dialog.getByText(unavailable)).toBeVisible();
    await expect(dialog.getByText('We could not complete that action. Try again.')).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Check outcome' })).toHaveCount(0);
    // The gate response itself refreshes the public rollout; no reload or focus change is needed.
    await expect.poll(() => reads.length).toBeGreaterThan(readsBeforeSend);
    await expect(page.locator('nav[aria-label="Primary"] a[href$="/social"]')).toHaveCount(0);
    await expect(dialog).toBeVisible();

    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toBeHidden();
    await expectNoSocialEntryPoints(page);
    expect(shares).toHaveLength(1);
  });
});
