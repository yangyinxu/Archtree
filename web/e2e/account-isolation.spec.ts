import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test';

import { homeFixture } from './fixtures/catalog';
import { privateLibraryPage } from './fixtures/privateListener';

const viewerA = 'e2e-viewer-a';
const viewerB = 'e2e-viewer-b';

const sessionFor = (viewerId: string, displayName: string) => ({
  user: {
    id: viewerId,
    email: `${viewerId}@example.test`,
    role: 'user',
    displayName,
    avatarRevision: 1,
    avatar: { assetId: `${viewerId}-avatar`, revision: 1 },
    emailVerified: true,
    authenticationMethods: ['password']
  }
});

const sessions = {
  [viewerA]: sessionFor(viewerA, 'Viewer A'),
  [viewerB]: sessionFor(viewerB, 'Viewer B')
};

const libraryFor = (viewerId: string) => {
  const item = privateLibraryPage.items[0];
  if (item.contentType !== 'album') {
    throw new Error('The account-isolation fixture must start with an album.');
  }

  return {
    ...privateLibraryPage,
    items: [{
      ...item,
      contentId: `${viewerId}-album`,
      album: {
        ...item.album,
        _id: `${viewerId}-album`,
        title: `${viewerId} private album`
      }
    }]
  };
};

const playlistFor = (viewerId: string) => ({
  id: `${viewerId}-playlist`,
  name: `${viewerId} private playlist`,
  itemCount: 0,
  artworkUrl: '',
  revision: 1,
  createdAt: '2026-08-05T10:00:00.000Z',
  updatedAt: '2026-08-05T10:00:00.000Z'
});

const deviceFor = (viewerId: string) => ({
  id: `${viewerId}-session`,
  createdAt: '2026-08-05T09:00:00.000Z',
  lastUsedAt: '2026-08-05T10:00:00.000Z',
  expiresAt: '2026-09-05T10:00:00.000Z',
  userAgent: 'bounded e2e fixture',
  deviceName: `${viewerId} private device`,
  deviceType: 'Desktop',
  isCurrent: true
});

const privateJson = (
  route: Route,
  activeViewer: string,
  payload: unknown,
  status = 200
) => route.fulfill({
  status,
  contentType: 'application/json; charset=utf-8',
  headers: {
    'Cache-Control': 'private, no-store',
    'X-Finitude-Account-Viewer': activeViewer
  },
  body: JSON.stringify(payload)
});

const mismatch = (route: Route) => route.fulfill({
  status: 409,
  contentType: 'application/json; charset=utf-8',
  headers: { 'Cache-Control': 'no-store' },
  body: JSON.stringify({
    code: 'account_viewer_mismatch',
    message: 'The active account changed. Refresh the account before trying again.'
  })
});

test('an A tab cannot consume or mutate B data and both tabs reconcile to B', async ({
  browser,
  baseURL
}) => {
  const context: BrowserContext = await browser.newContext({ baseURL });
  const pageA = await context.newPage();
  const pageB = await context.newPage();
  let activeViewer = viewerA;
  let pageBLoggedIn = false;
  let avatarAReads = 0;
  let releaseDelayedAvatar!: () => void;
  let settleDelayedAvatar!: () => void;
  let releaseLogin!: () => void;
  let loginStarted!: () => void;
  const delayedAvatar = new Promise<void>((resolve) => { releaseDelayedAvatar = resolve; });
  const delayedAvatarSettled = new Promise<void>((resolve) => { settleDelayedAvatar = resolve; });
  const loginGate = new Promise<void>((resolve) => { releaseLogin = resolve; });
  const loginHasStarted = new Promise<void>((resolve) => { loginStarted = resolve; });
  const rejectedMutations: string[] = [];
  const appliedMutations: string[] = [];
  const privateRequests: Array<{ path: string; viewer?: string }> = [];
  const onePixelPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
  );

  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const page = request.frame().page();
    if (!path.startsWith('/api/') && !path.startsWith('/auth/') && !path.startsWith('/content/')) {
      await route.continue();
      return;
    }

    if (path === '/auth/browser/session' && request.method() === 'GET') {
      if (page === pageB && !pageBLoggedIn) {
        await route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({ message: 'Signed out.' })
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'Cache-Control': 'no-store' },
        body: JSON.stringify(sessions[activeViewer as keyof typeof sessions])
      });
      return;
    }
    if (path === '/auth/browser/login' && request.method() === 'POST') {
      activeViewer = viewerB;
      loginStarted();
      await loginGate;
      pageBLoggedIn = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'Cache-Control': 'no-store' },
        body: JSON.stringify(sessions[viewerB])
      });
      return;
    }
    if (path === '/auth/browser/refresh' && request.method() === 'POST') {
      await route.fulfill({ status: 401, contentType: 'application/json', body: '{}' });
      return;
    }
    if (path === '/auth/browser/capabilities') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          password: true,
          emailRegistration: true,
          apple: false,
          google: false,
          passkey: false
        })
      });
      return;
    }
    if (path === '/api/listener/v1/capabilities') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ playlists: true })
      });
      return;
    }
    if (path === '/api/listener/v1/telemetry') {
      await route.fulfill({ status: 204 });
      return;
    }

    const requestedViewer = request.headers()['x-finitude-account-viewer'];
    privateRequests.push({ path, viewer: requestedViewer });
    if (requestedViewer !== activeViewer) {
      if (['PUT', 'DELETE'].includes(request.method())
        && path.startsWith('/content/me/saves/')) rejectedMutations.push(request.method());
      await mismatch(route);
      return;
    }

    if (path === '/api/listener/v1/library') {
      await privateJson(route, activeViewer, libraryFor(activeViewer));
      return;
    }
    if (path === '/api/listener/v1/home') {
      await privateJson(route, activeViewer, {
        ...homeFixture,
        title: `${activeViewer} private home`
      });
      return;
    }
    if (path === '/content/me/playlists' && request.method() === 'GET') {
      await privateJson(route, activeViewer, {
        items: [playlistFor(activeViewer)],
        nextCursor: null
      });
      return;
    }
    if (path === '/content/me/saves/status') {
      const body = request.postDataJSON() as {
        items?: Array<{ contentType: 'album' | 'audioTrack'; contentId: string }>;
      };
      await privateJson(route, activeViewer, {
        items: (body.items ?? []).map((item) => ({ ...item, saved: true }))
      });
      return;
    }
    if (path.startsWith('/content/me/saves/') && ['PUT', 'DELETE'].includes(request.method())) {
      appliedMutations.push(`${activeViewer}:${request.method()}`);
      const [, , , , contentType, contentId] = path.split('/');
      await privateJson(route, activeViewer, {
        contentType,
        contentId,
        saved: request.method() === 'PUT'
      });
      return;
    }
    if (path === '/auth/sessions') {
      await privateJson(route, activeViewer, { sessions: [deviceFor(activeViewer)] });
      return;
    }
    if (path === '/auth/avatar') {
      if (requestedViewer === viewerA) {
        avatarAReads += 1;
        await delayedAvatar;
        try {
          await route.fulfill({
            status: 200,
            headers: {
              'Cache-Control': 'private, no-store',
              'Content-Type': 'image/png',
              'X-Finitude-Account-Viewer': viewerA
            },
            body: onePixelPng
          });
        } catch {
          // Session reconciliation is expected to abort this stale response.
        } finally {
          settleDelayedAvatar();
        }
        return;
      }
      await route.fulfill({
        status: 200,
        headers: {
          'Cache-Control': 'private, no-store',
          'Content-Type': 'image/png',
          'X-Finitude-Account-Viewer': activeViewer
        },
        body: onePixelPng
      });
      return;
    }

    await route.fulfill({ status: 501, contentType: 'application/json', body: '{}' });
  });

  await pageA.goto('/finitude/library');
  await expect(pageA.getByText(`${viewerA} private album`)).toBeVisible();
  await expect(pageA.getByRole('link', { name: 'Viewer A' })).toBeVisible();
  await expect.poll(() => avatarAReads).toBe(1);

  await pageB.goto('/finitude/login');
  await pageB.getByLabel('Email or username').fill(`${viewerB}@example.test`);
  await pageB.getByLabel('Password').fill('e2e private password');
  const loginClick = pageB.getByRole('button', { name: 'Log in' }).click();
  await loginHasStarted;

  const staleSaveStatus = await pageA.evaluate(async ({ viewer, contentId }) => {
    const response = await fetch(`/content/me/saves/album/${contentId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Finitude-Account-Viewer': viewer
      },
      body: '{}'
    });
    return response.status;
  }, { viewer: viewerA, contentId: `${viewerA}-other-album` });
  expect(staleSaveStatus).toBe(409);

  await pageA.getByRole('button', { name: 'Remove from Library' }).click();
  await expect.poll(() => rejectedMutations.sort()).toEqual(['DELETE', 'PUT']);
  await expect(pageA.getByText(`${viewerB} private album`)).toBeVisible();
  await expect(pageA.getByRole('link', { name: 'Viewer B' })).toBeVisible();
  expect(appliedMutations).toEqual([]);

  const viewerBAvatar = pageA.getByRole('link', { name: 'Viewer B' }).locator('img');
  await expect(viewerBAvatar).toBeVisible();
  const viewerBAvatarSource = await viewerBAvatar.getAttribute('src');
  releaseDelayedAvatar();
  await delayedAvatarSettled;
  await expect(viewerBAvatar).toHaveAttribute('src', viewerBAvatarSource ?? '');
  await expect(pageA.getByText(`${viewerA} private album`)).toHaveCount(0);
  releaseLogin();
  await loginClick;
  await expect(pageB).toHaveURL(/\/finitude$/);
  await expect(pageB.getByRole('link', { name: 'Viewer B' })).toBeVisible();

  const postSwitchRequestStart = privateRequests.length;
  await pageA.goto('/finitude');
  await expect(pageA.getByRole('heading', { name: `${viewerB} private home` })).toBeVisible();
  await pageA.goto('/finitude/playlists');
  await expect(pageA.locator('#main-content').getByRole('link', {
    name: `${viewerB} private playlist`
  })).toBeVisible();
  await pageA.goto('/finitude/account/sessions');
  await expect(pageA.getByText(`${viewerB} private device`)).toBeVisible();
  await expect(pageA.getByText(`${viewerA} private device`)).toHaveCount(0);

  const postSwitchPrivateRequests = privateRequests.slice(postSwitchRequestStart);
  expect(postSwitchPrivateRequests.map(({ path }) => path)).toEqual(expect.arrayContaining([
    '/api/listener/v1/home',
    '/content/me/playlists',
    '/auth/sessions'
  ]));
  expect(postSwitchPrivateRequests.every(({ viewer }) => viewer === viewerB)).toBe(true);
  expect(privateRequests.some(({ path, viewer }) => (
    path === '/auth/avatar' && viewer === viewerB
  ))).toBe(true);

  await context.close();
});
