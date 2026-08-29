import type { ListenerHome } from '../src/api/contentSchemas';

import { trackFixtures } from './fixtures/catalog';
import { expect, test } from './support/test';

const pageItemId = '64b000000000000000000301';
const parentHome = {
  title: 'Paginated listening room',
  sections: [{
    id: pageItemId,
    title: 'Cursor ordered tracks',
    presentation: 'list',
    items: [{ ...trackFixtures[0], id: 'legacy-parent-item', title: 'Legacy parent item' }]
  }]
} satisfies ListenerHome;

const collectionPage = (index: number, nextCursor: string | null) => {
  const item = trackFixtures[index];
  return {
    pageItem: {
      id: pageItemId,
      pageSlug: 'home',
      title: 'Cursor ordered tracks',
      presentation: 'list',
      mode: 'manual',
      contentType: 'audioTrack'
    },
    items: [{ contentType: 'audioTrack', contentId: item.id, order: index }],
    included: { albums: [], audioTracks: [item] },
    limit: 20,
    nextCursor
  };
};

test('loads attached List pages independently from the Home compatibility payload', async ({ page }) => {
  const collectionRequests: string[] = [];
  await page.route('**/api/listener/v1/home', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify(parentHome)
  }));
  await page.route(`**/api/listener/v1/pages/home/items/${pageItemId}**`, (route) => {
    const url = new URL(route.request().url());
    collectionRequests.push(url.search);
    const hasCursor = url.searchParams.get('cursor') === 'second-page';
    return route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify(collectionPage(hasCursor ? 1 : 0, hasCursor ? null : 'second-page'))
    });
  });

  await page.goto('/finitude');

  await expect(page.getByText('First Light', { exact: true })).toBeVisible();
  await expect(page.getByText('Legacy parent item', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Load more' }).click();
  await expect(page.getByText('Night Window', { exact: true })).toBeVisible();
  expect(collectionRequests).toEqual(['?limit=20', '?limit=20&cursor=second-page']);
});
