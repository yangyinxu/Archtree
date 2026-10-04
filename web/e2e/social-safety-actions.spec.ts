import type { Page, Route } from '@playwright/test';

import { privateViewerSession } from './fixtures/privateListener';
import { expectNoUnownedAxeViolations } from './support/accessibility';
import { installPrivateListenerRoutes } from './support/privateRoutes';
import { expect, test } from './support/test';

const viewer = privateViewerSession.user.id;
const card = (index: number, alias: string, handle: string) => ({ socialId: `s_${index.toString(16).padStart(32, '0')}`, handle, alias, iconSeed: handle });
const own = card(0xa11ce, 'Alice', 'alice');
const bob = card(0xb0b, 'Bob', 'bobby');
const carol = card(0xca401, 'Carol', 'carol');
const listener = (index: number) => ({ peer: card(index, `Friend ${index}`, `friend${index}`), expiresAtMs: Date.now() + 600_000,
  track: { id: index.toString(16).padStart(24, '0'), contentType: 'audioTrack', title: `Song ${index}`, artworkUrl: '', artistNames: ['Synthetic Artist'] } });

const json = (route: Route, payload: unknown, status = 200) => route.fulfill({
  status,
  contentType: 'application/json; charset=utf-8',
  headers: { 'Cache-Control': 'private, no-store', 'X-Finitude-Account-Viewer': viewer },
  body: JSON.stringify(payload)
});

/** A synthetic social backend for one signed-in listener; every unexpected social call fails the test. */
const installSocial = async (page: Page) => {
  const mutations: { path: string; body: Record<string, unknown> }[] = [];
  const listeningReads: (string | null)[] = [];
  const unexpected: string[] = [];
  await page.route('**/api/listener/v1/capabilities', route => json(route, { playlists: true, social: { enabled: true, rooms: false } }));
  await page.route('**/api/social/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace('/api/social/v1', '');
    if (request.method() === 'GET') {
      if (path === '/me/profile') return json(route, { profile: { ...own, active: true, discoverable: true, revision: 1 } });
      if (path === '/capabilities') return json(route, { socialEnabled: true, roomsEnabled: false });
      if (path === '/room-invitations') return json(route, { invitations: [] });
      if (path === '/rooms/current') return json(route, { room: null });
      if (path === '/me/listening') return json(route, { listening: { enabled: false, revision: 0, publisherRevision: 0, serverTimeMs: Date.now() } });
      if (path === '/listening-status/friends') {
        const cursor = url.searchParams.get('cursor');
        listeningReads.push(cursor);
        return json(route, cursor === 'page-two' ? { items: [listener(21)], nextCursor: null }
          : { items: Array.from({ length: 20 }, (_, index) => listener(index + 1)), nextCursor: 'page-two' });
      }
      if (path === '/relationships') {
        return json(route, { items: url.searchParams.get('kind') === 'friends' ? [{ socialId: bob.socialId, profile: bob, revision: 5 }] : [], nextCursor: null });
      }
      if (path === '/profiles' && url.searchParams.get('handle') === 'carol') return json(route, { profile: carol });
      if (path === `/relationships/${carol.socialId}`) return json(route, { relationship: { socialId: carol.socialId, state: 'none', revision: 0 } });
    }
    if (request.method() === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>;
      if (path === '/mutation-scopes') return json(route, { scopeToken: 'synthetic-safety-action-scope', expiresAt: new Date(Date.now() + 60_000).toISOString() });
      if (/^\/relationships\/s_[a-f0-9]{32}\/(remove|block)$/.test(path)) {
        mutations.push({ path, body });
        return json(route, { commandId: body.commandId, outcome: 'applied', replayed: false });
      }
    }
    unexpected.push(`${request.method()} ${path}${url.search}`);
    return json(route, { code: 'not_found', message: 'Not found.' }, 404);
  });
  return { mutations, listeningReads, unexpected };
};

test.describe('Together safety actions and listening friends', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1_280, height: 900 });
    await installPrivateListenerRoutes(page);
  });

  test('Remove friend and Block from lookup ask in an accessible dialog before sending anything', async ({ page }) => {
    const social = await installSocial(page);
    await page.goto('/finitude/social');
    await expect(page.getByRole('heading', { level: 1, name: 'Listen together' })).toBeVisible();

    const remove = page.getByRole('button', { name: 'Remove friend', exact: true });
    await remove.click();
    const dialog = page.getByRole('dialog', { name: 'Remove Bob from your friends?' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('You and Bob stop seeing each other’s listening status');
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await expectNoUnownedAxeViolations(page, 'remove-friend-confirmation');
    // Focus stays inside the modal and Escape cancels without a request.
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(remove).toBeFocused();
    expect(social.mutations).toEqual([]);

    await remove.click();
    await dialog.getByRole('button', { name: 'Remove friend' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText('Updated.', { exact: true })).toBeVisible();
    expect(social.mutations).toHaveLength(1);
    expect(social.mutations[0].path).toBe(`/relationships/${bob.socialId}/remove`);
    expect(social.mutations[0].body).toMatchObject({ expectedRevision: 5 });

    const lookup = page.locator('section').filter({ has: page.getByRole('form', { name: 'Find a friend' }) });
    await lookup.getByLabel('Handle').fill('carol');
    await lookup.getByRole('button', { name: 'Find', exact: true }).click();
    await expect(lookup.getByText('@carol')).toBeVisible();
    await expect(lookup.getByRole('button', { name: 'Add friend' })).toBeVisible();
    await lookup.getByRole('button', { name: 'Block', exact: true }).click();
    const block = page.getByRole('dialog', { name: 'Block Carol?' });
    await expect(block).toContainText('Unblocking later does not restore the friendship.');
    await page.setViewportSize({ width: 320, height: 800 });
    await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('html, body, [role="dialog"]')]
      .every(element => element.scrollWidth <= element.clientWidth + 1)), { message: 'no horizontal overflow at 320px' }).toBe(true);
    await block.getByRole('button', { name: 'Block', exact: true }).click();
    await expect(block).toBeHidden();
    await expect.poll(() => social.mutations.length).toBe(2);
    expect(social.mutations[1].path).toBe(`/relationships/${carol.socialId}/block`);
    expect(social.mutations[1].body).not.toHaveProperty('expectedRevision');
    expect(social.unexpected).toEqual([]);
  });

  test('Listening with friends shows friends beyond the first page after Load more', async ({ page }) => {
    const social = await installSocial(page);
    await page.goto('/finitude/social');
    const panel = page.getByRole('region', { name: 'Listening with friends' });
    await panel.scrollIntoViewIfNeeded();
    await expect(panel.getByText('Friend 20 is listening', { exact: true })).toBeVisible();
    await expect(panel.getByText('Friend 21 is listening', { exact: true })).toHaveCount(0);
    await panel.getByRole('button', { name: 'Load more' }).click();
    await expect(panel.getByText('Friend 21 is listening', { exact: true })).toBeVisible();
    await expect(panel.getByRole('listitem')).toHaveCount(21);
    await expect(panel.getByRole('button', { name: 'Load more' })).toHaveCount(0);
    expect(social.listeningReads).toContain('page-two');
    expect(social.unexpected).toEqual([]);
  });
});
