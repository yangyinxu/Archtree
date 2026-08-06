import type { Route } from '@playwright/test';

import type { PlaylistDetail, PlaylistSummary } from '../src/api/playlists';
import { trackFixtures } from './fixtures/catalog';
import { expect, test } from './support/test';

const viewerId = 'e2e-playlist-listener';
const playlistId = 'e2e-playlist';

const session = {
  user: {
    id: viewerId,
    email: 'playlist-listener@example.com',
    role: 'user',
    displayName: 'Playlist Listener',
    avatarRevision: 0,
    avatar: null,
    emailVerified: true
  }
};

const json = (route: Route, status: number, body: unknown, revision?: number) => route.fulfill({
  status,
  contentType: 'application/json; charset=utf-8',
  headers: {
    'Cache-Control': 'private, no-store',
    'X-Finitude-Account-Viewer': viewerId,
    ...(revision ? { ETag: `"${revision}"` } : {})
  },
  body: JSON.stringify(body)
});

test('keeps signed-out New Playlist in place and explains authentication', async ({ api, page }) => {
  await page.goto('/finitude/playlists');
  await expect(page.getByRole('heading', { name: 'Log in to open your Playlists' })).toBeVisible();

  await page.getByRole('main').getByRole('button', { name: 'New Playlist' }).click();

  await expect(page.getByRole('dialog', { name: 'Log in to create a Playlist' })).toBeVisible();
  await expect(page).toHaveURL(/\/finitude\/playlists$/);
  expect(api.calls.filter((call) => call.pathname.startsWith('/content/me/playlists'))).toEqual([]);
});

test('creates, renames, composes, reorders, plays, removes, and deletes one Playlist', async ({ page }) => {
  let playlist: PlaylistDetail | null = null;
  let itemSequence = 0;
  const mutationGuards: Array<{ method: string; ifMatch?: string; idempotency?: string; viewer?: string }> = [];
  const activity: unknown[] = [];

  const summary = (): PlaylistSummary => {
    if (!playlist) throw new Error('Playlist is missing.');
    const { items: _items, ...value } = playlist;
    return value;
  };
  const update = (changes: Partial<PlaylistDetail>) => {
    if (!playlist) throw new Error('Playlist is missing.');
    playlist = {
      ...playlist,
      ...changes,
      revision: playlist.revision + 1,
      updatedAt: new Date(Date.UTC(2026, 7, 4, 13, 0, playlist.revision)).toISOString()
    };
  };

  await page.route('**/auth/browser/session', (route) => json(route, 200, session));
  await page.route('**/content/me/recently-played', async (route) => {
    const body = route.request().postDataJSON();
    activity.push(body);
    await json(route, 200, { ...body, recorded: true });
  });
  await page.route('**/content/me/playlists**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const relative = url.pathname.slice('/content/me/playlists'.length);
    if (method !== 'GET') {
      mutationGuards.push({
        method,
        ifMatch: request.headers()['if-match'],
        idempotency: request.headers()['idempotency-key'],
        viewer: request.headers()['x-finitude-account-viewer']
      });
    }

    if (!relative && method === 'GET') {
      await json(route, 200, { items: playlist ? [summary()] : [], nextCursor: null });
      return;
    }
    if (!relative && method === 'POST') {
      const { name } = request.postDataJSON() as { name: string };
      playlist = {
        id: playlistId,
        name,
        itemCount: 0,
        artworkUrl: '',
        revision: 1,
        createdAt: '2026-08-04T13:00:00.000Z',
        updatedAt: '2026-08-04T13:00:00.000Z',
        items: []
      };
      await json(route, 201, playlist, playlist.revision);
      return;
    }
    if (!playlist) {
      await json(route, 404, { code: 'playlist_not_found', message: 'Playlist not found.' });
      return;
    }
    if (relative === `/${playlistId}` && method === 'GET') {
      await json(route, 200, playlist, playlist.revision);
      return;
    }
    if (relative === `/${playlistId}` && method === 'PATCH') {
      update({ name: (request.postDataJSON() as { name: string }).name });
      await json(route, 200, playlist, playlist.revision);
      return;
    }
    if (relative === `/${playlistId}/items` && method === 'POST') {
      const { audioTrackId } = request.postDataJSON() as { audioTrackId: string };
      if (!playlist.items.some((item) => item.audioTrackId === audioTrackId)) {
        const track = trackFixtures.find((candidate) => candidate.id === audioTrackId);
        if (!track) {
          await json(route, 404, { code: 'audio_track_not_found', message: 'Soundtrack not found.' });
          return;
        }
        itemSequence += 1;
        const items = [...playlist.items, {
          itemId: `e2e-item-${itemSequence}`,
          audioTrackId,
          addedAt: new Date(Date.UTC(2026, 7, 4, 13, 1, itemSequence)).toISOString(),
          availability: 'ready' as const,
          audioTrack: track
        }];
        update({ items, itemCount: items.length });
      }
      await json(route, 200, playlist, playlist.revision);
      return;
    }
    if (relative === `/${playlistId}/items/order` && method === 'PUT') {
      const { itemIds } = request.postDataJSON() as { itemIds: string[] };
      const byId = new Map(playlist.items.map((item) => [item.itemId, item]));
      update({ items: itemIds.map((itemId) => byId.get(itemId)!) });
      await json(route, 200, playlist, playlist.revision);
      return;
    }
    if (relative.startsWith(`/${playlistId}/items/`) && method === 'DELETE') {
      const itemId = relative.split('/').at(-1);
      const items = playlist.items.filter((item) => item.itemId !== itemId);
      update({ items, itemCount: items.length });
      await json(route, 200, playlist, playlist.revision);
      return;
    }
    if (relative === `/${playlistId}` && method === 'DELETE') {
      playlist = null;
      await route.fulfill({
        status: 204,
        headers: {
          'Cache-Control': 'private, no-store',
          'X-Finitude-Account-Viewer': viewerId
        },
        body: ''
      });
      return;
    }
    await json(route, 501, { message: 'Unhandled Playlist fixture request.' });
  });

  await page.goto('/finitude/playlists');
  await expect(page.getByRole('heading', { name: 'Make room for a new sequence' })).toBeVisible();
  await page.getByRole('button', { name: 'New Playlist' }).first().click();
  await page.getByRole('textbox', { name: 'Name' }).fill('Night order');
  await page.getByRole('button', { name: 'Create Playlist' }).click();
  await expect(page).toHaveURL(new RegExp(`/finitude/playlists/${playlistId}$`));

  await page.getByRole('button', { name: 'Rename' }).click();
  await page.getByRole('textbox', { name: 'Name' }).fill('Quiet order');
  await page.getByRole('button', { name: 'Save name' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Quiet order' })).toBeVisible();

  await page.getByRole('button', { name: 'Add Soundtracks' }).first().click();
  const addDialog = page.getByRole('dialog', { name: 'Add Soundtracks' });
  await addDialog.getByRole('searchbox', { name: 'Search ready Soundtracks' }).fill('Light');
  await addDialog.getByRole('button', { name: 'Search' }).click();
  await addDialog.getByRole('button', { name: 'Add First Light to Quiet order' }).click();
  await expect(addDialog.getByText('First Light added.')).toBeVisible();
  await addDialog.getByRole('button', { name: 'Add Night Window to Quiet order' }).click();
  await expect(addDialog.getByText('Night Window added.')).toBeVisible();
  await addDialog.getByRole('button', { name: 'Done' }).click();

  await page.getByRole('button', { name: 'Actions for Night Window' }).click();
  await page.getByRole('menuitem', { name: 'Move Up' }).click();
  await expect(page.locator('ol li').first()).toContainText('Night Window');

  await page.getByRole('button', { name: 'Play Night Window' }).click();
  const player = page.getByRole('region', { name: 'Now playing' });
  await expect(player.getByText('Night Window', { exact: true })).toBeVisible();
  await expect.poll(() => activity).toEqual([{ contentType: 'audioTrack', contentId: trackFixtures[1].id }]);

  await page.getByRole('button', { name: 'Actions for First Light' }).click();
  await page.getByRole('menuitem', { name: 'Remove from Playlist' }).click();
  await expect(page.getByRole('button', { name: 'Play First Light' })).toHaveCount(0);

  await page.getByRole('button', { name: 'More actions for Quiet order' }).click();
  await page.getByRole('menuitem', { name: 'Delete Playlist' }).click();
  await page.getByRole('button', { name: 'Delete Playlist' }).click();
  await expect(page).toHaveURL(/\/finitude\/playlists$/);
  await expect(page.getByRole('heading', { name: 'Make room for a new sequence' })).toBeVisible();
  await expect(player.getByText('Night Window', { exact: true })).toBeVisible();

  expect(mutationGuards).toHaveLength(7);
  expect(mutationGuards.every((guard) => guard.idempotency && guard.viewer === viewerId)).toBe(true);
  expect(mutationGuards[0].ifMatch).toBeUndefined();
  expect(mutationGuards.slice(1).every((guard) => /^"\d+"$/.test(guard.ifMatch ?? ''))).toBe(true);
});

test('keeps owner-safe 404 and rolls back a stale reorder conflict', async ({ page }) => {
  const conflict: PlaylistDetail = {
    id: 'conflict-playlist',
    name: 'Concurrent order',
    itemCount: 2,
    artworkUrl: '',
    revision: 7,
    createdAt: '2026-08-04T14:00:00.000Z',
    updatedAt: '2026-08-04T14:02:00.000Z',
    items: trackFixtures.map((track, index) => ({
      itemId: `conflict-item-${index + 1}`,
      audioTrackId: track.id,
      addedAt: `2026-08-04T14:0${index}:00.000Z`,
      availability: 'ready' as const,
      audioTrack: track
    }))
  };
  const conflictSummary = (() => {
    const { items: _items, ...value } = conflict;
    return value;
  })();

  await page.route('**/auth/browser/session', (route) => json(route, 200, session));
  await page.route('**/content/me/playlists**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname === '/content/me/playlists') {
      await json(route, 200, { items: [conflictSummary], nextCursor: null });
      return;
    }
    if (request.method() === 'GET' && url.pathname.endsWith('/missing-playlist')) {
      await json(route, 404, { code: 'playlist_not_found', message: 'Playlist not found.' });
      return;
    }
    if (request.method() === 'GET' && url.pathname.endsWith('/conflict-playlist')) {
      await json(route, 200, conflict, conflict.revision);
      return;
    }
    if (request.method() === 'PUT' && url.pathname.endsWith('/conflict-playlist/items/order')) {
      await json(route, 409, {
        code: 'playlist_revision_conflict',
        message: 'Playlist changed.',
        currentRevision: conflict.revision,
        playlist: conflictSummary
      });
      return;
    }
    await json(route, 501, { message: 'Unhandled conflict fixture request.' });
  });

  await page.goto('/finitude/playlists/missing-playlist');
  await expect(page.getByRole('heading', { name: 'Playlist not found' })).toBeVisible();
  await expect(page.getByText(/belongs to another listener/)).toBeVisible();

  await page.goto('/finitude/playlists/conflict-playlist');
  await expect(page.getByRole('heading', { level: 1, name: 'Concurrent order' })).toBeVisible();
  await page.getByRole('button', { name: 'Actions for Night Window' }).click();
  await page.getByRole('menuitem', { name: 'Move Up' }).click();

  await expect(page.getByRole('alert')).toContainText('changed on another device');
  await expect(page.getByText('Move was not saved.')).toBeAttached();
  await expect(page.locator('ol li').first()).toContainText('First Light');
  await expect(page.locator('ol li').nth(1)).toContainText('Night Window');
});

for (const width of [320, 768, 1_024, 1_440]) {
  test(`keeps the signed-out Playlist index within a ${width}px viewport`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/finitude/playlists');
    await expect(page.getByRole('heading', { name: 'Log in to open your Playlists' })).toBeVisible();
    const dimensions = await page.evaluate(() => ({
      body: document.body.scrollWidth,
      document: document.documentElement.scrollWidth,
      viewport: document.documentElement.clientWidth
    }));
    expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport + 1);
    expect(dimensions.body).toBeLessThanOrEqual(dimensions.viewport + 1);
  });
}
