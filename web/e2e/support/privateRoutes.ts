import type { Page, Route } from '@playwright/test';

import type {
  LibraryPage,
  ListenerArtist,
  ListenerHome
} from '../../src/api/contentSchemas';
import type {
  PlaylistDetail,
  PlaylistSummary
} from '../../src/api/playlists';
import type { BrowserSession } from '../../src/api/schemas';
import { homeFixture } from '../fixtures/catalog';
import {
  privateArtistPage,
  privateLibraryPage,
  privatePlaylistDetail,
  privatePlaylistSummary,
  privateViewerSession
} from '../fixtures/privateListener';

interface PrivateListenerRouteOptions {
  session?: BrowserSession;
  home?: ListenerHome;
  library?: LibraryPage;
  artist?: ListenerArtist;
  playlists?: PlaylistSummary[];
  playlistDetail?: PlaylistDetail;
}

const json = (
  route: Route,
  status: number,
  payload: unknown,
  accountViewer?: string
) => route.fulfill({
  status,
  contentType: 'application/json; charset=utf-8',
  headers: {
    'Cache-Control': 'private, no-store',
    ...(accountViewer ? { 'X-Finitude-Account-Viewer': accountViewer } : {})
  },
  body: JSON.stringify(payload)
});

/** Adds deterministic owner-scoped responses after the strict public fixture. */
export const installPrivateListenerRoutes = async (
  page: Page,
  options: PrivateListenerRouteOptions = {}
) => {
  const session = options.session ?? privateViewerSession;
  const home = options.home ?? homeFixture;
  const library = options.library ?? privateLibraryPage;
  const artist = options.artist ?? privateArtistPage;
  const playlists = options.playlists ?? [privatePlaylistSummary];
  const playlistDetail = options.playlistDetail ?? privatePlaylistDetail;
  const privateJson = (route: Route, status: number, payload: unknown) =>
    json(route, status, payload, session.user.id);

  await page.route('**/auth/browser/session', (route) => json(route, 200, session));
  await page.route('**/api/listener/v1/home', (route) => privateJson(route, 200, home));
  await page.route('**/api/listener/v1/library**', (route) => privateJson(route, 200, library));
  await page.route('**/api/listener/v1/artists/**', (route) => json(route, 200, artist));
  await page.route('**/content/me/saves/status', async (route) => {
    const input = route.request().postDataJSON() as {
      items?: Array<{ contentType: 'album' | 'audioTrack'; contentId: string }>;
    };
    await privateJson(route, 200, {
      items: (input.items ?? []).map((item) => ({ ...item, saved: true }))
    });
  });
  await page.route('**/content/me/playlists**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const relativePath = url.pathname.slice('/content/me/playlists'.length);

    if (request.method() !== 'GET') {
      await privateJson(route, 501, { message: 'Private E2E fixture is read-only.' });
      return;
    }
    if (relativePath === '/memberships') {
      const audioTrackIds = (url.searchParams.get('audioTrackIds') ?? '')
        .split(',')
        .filter(Boolean);
      await privateJson(route, 200, {
        items: audioTrackIds.map((audioTrackId) => ({ audioTrackId, playlistIds: [] }))
      });
      return;
    }
    if (!relativePath) {
      await privateJson(route, 200, { items: playlists, nextCursor: null });
      return;
    }
    if (relativePath === `/${playlistDetail.id}`) {
      await privateJson(route, 200, playlistDetail);
      return;
    }
    await privateJson(route, 404, { code: 'playlist_not_found', message: 'Playlist not found.' });
  });
};
