import type { Page } from '@playwright/test';

import { catalogIds, homeFixture } from './fixtures/catalog';
import {
  privatePlaylistSummary,
  privateViewerSession
} from './fixtures/privateListener';
import { expectNoUnownedAxeViolations } from './support/accessibility';
import { installPrivateListenerRoutes } from './support/privateRoutes';
import { expect, test } from './support/test';

test.beforeEach(async ({ page }) => {
  // Accessibility scans should evaluate settled colors, not a transient frame
  // of an entrance animation or hover transition.
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

const publicPages = [
  {
    label: 'home',
    path: '/finitude',
    ready: (page: Page) => page.getByRole('heading', { name: 'Browser Test Listening Room' })
  },
  {
    label: 'search-default',
    path: '/finitude/search',
    ready: (page: Page) => page.getByRole('heading', { level: 1, name: 'Search' })
  },
  {
    label: 'library-signed-out',
    path: '/finitude/library',
    ready: (page: Page) => page.getByRole('heading', { name: 'Log in to open your Library' })
  },
  {
    label: 'album',
    path: `/finitude/albums/${catalogIds.album}`,
    ready: (page: Page) => page.getByRole('heading', { level: 1, name: 'Quiet Hours' })
  },
  {
    label: 'login',
    path: '/finitude/login',
    ready: (page: Page) => page.getByRole('heading', { name: 'Pick up where the music left you.' })
  },
  {
    label: 'account-signed-out',
    path: '/finitude/account',
    ready: (page: Page) => page.getByRole('heading', { name: 'You are not logged in' })
  },
  {
    label: 'playlists-signed-out',
    path: '/finitude/playlists',
    ready: (page: Page) => page.getByRole('heading', { name: 'Log in to open your Playlists' })
  }
] as const;

for (const target of publicPages) {
  test(`${target.label} has no unowned axe findings`, async ({ page }) => {
    await page.goto(target.path);
    await expect(target.ready(page)).toBeVisible();
    await expectNoUnownedAxeViolations(page, target.label);
  });
}

test('grouped Search results have no unowned axe findings', async ({ page }) => {
  await page.goto('/finitude/search?q=Night');
  await expect(page.getByRole('heading', { name: 'Results for “Night”' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Albums' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Soundtracks' })).toBeVisible();
  await expectNoUnownedAxeViolations(page, 'search-results');
});

test.describe('signed-in surfaces', () => {
  test.beforeEach(async ({ page }) => {
    await installPrivateListenerRoutes(page);
  });

  test('Artist has no unowned axe findings', async ({ page }) => {
    await page.goto(`/finitude/artists/${catalogIds.artist}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Finitude Ensemble' })).toBeVisible();
    await expectNoUnownedAxeViolations(page, 'artist');
  });

  test('Library has no unowned axe findings', async ({ page }) => {
    await page.goto('/finitude/library');
    await expect(page.getByRole('list', { name: 'Saved Albums and Soundtracks' })).toBeVisible();
    await expectNoUnownedAxeViolations(page, 'library-signed-in');
  });

  test('Account has no unowned axe findings', async ({ page }) => {
    await page.goto('/finitude/account');
    await expect(page.getByText(privateViewerSession.user.email).first()).toBeVisible();
    await expectNoUnownedAxeViolations(page, 'account-signed-in');
  });

  test('Playlist menu and dialog have no unowned axe findings', async ({ page }) => {
    await page.goto('/finitude/playlists');
    const actions = page.getByRole('main').getByRole('button', {
      name: `Actions for ${privatePlaylistSummary.name}`
    });
    await expect(actions).toBeVisible();
    await expectNoUnownedAxeViolations(page, 'playlist-signed-in');

    await actions.press('ArrowDown');
    const menu = page.getByRole('menu', { name: `Actions for ${privatePlaylistSummary.name}` });
    await expect(menu).toBeVisible();
    await expectNoUnownedAxeViolations(page, 'playlist-action-menu');

    await menu.getByRole('menuitem', { name: 'Rename' }).click();
    const dialog = page.getByRole('dialog', { name: 'Rename Playlist' });
    await expect(dialog).toBeVisible();
    await expectNoUnownedAxeViolations(page, 'playlist-rename-dialog');
  });
});

test('Home loading state has no unowned axe findings', async ({ page }) => {
  let releaseResponse = () => {};
  const responseGate = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  await page.route('**/api/listener/v1/home', async (route) => {
    await responseGate;
    await route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify(homeFixture)
    });
  });
  await page.goto('/finitude');
  await expect(page.getByRole('region', { name: 'Loading Home' })).toBeVisible();

  try {
    await expectNoUnownedAxeViolations(page, 'home-loading');
  } finally {
    releaseResponse();
  }
  await expect(page.getByRole('heading', { name: 'Browser Test Listening Room' })).toBeVisible();
});

test('Home empty state has no unowned axe findings', async ({ page }) => {
  await page.route('**/api/listener/v1/home', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify({ title: 'Empty listening room', sections: [] })
  }));
  await page.goto('/finitude');
  await expect(page.getByRole('heading', { name: 'Begin with a feeling' })).toBeVisible();
  await expectNoUnownedAxeViolations(page, 'home-empty');
});

test('Home error and retry state has no unowned axe findings', async ({ page }) => {
  await page.route('**/api/listener/v1/home', (route) => route.fulfill({
    status: 503,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify({ message: 'Catalog unavailable.' })
  }));
  await page.goto('/finitude');
  await expect(page.getByRole('heading', { name: 'Home is taking a quiet moment' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expectNoUnownedAxeViolations(page, 'home-error');
});

test('mobile expanded player and shortcut help have no unowned axe findings', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/finitude/albums/${catalogIds.album}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Quiet Hours' })).toBeVisible();

  await page.getByRole('main')
    .locator('header')
    .getByRole('button', { name: 'Play', exact: true })
    .click();
  await page.getByRole('button', { name: 'Open Now Playing: First Light' }).click();

  const expanded = page.getByRole('dialog', { name: 'First Light' });
  await expect(expanded).toBeVisible();
  await expectNoUnownedAxeViolations(page, 'mobile-expanded-player');

  await expanded.getByRole('button', { name: 'Keyboard shortcuts' }).click();
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
  await expectNoUnownedAxeViolations(page, 'mobile-expanded-player-help');
});
