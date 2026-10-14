import { mkdir } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { capabilities, session, viewer } from '../src/features/admin/adminFixtures.testSupport';
import { albumId, catalogAlbum, catalogReview, reviewId, slotTwo, titleSuggestionId } from '../src/features/admin/catalogReviewFixtures.testSupport';
import type { CatalogReview } from '../src/features/admin/catalogReviewApi';

const shots = '/tmp/finitude-catalog-review-ui-20261014';
type Write = { path: string; method: string; body: Record<string, unknown> };

/** Only fabricated catalog data and route responses are used; no provider, storage or account is contacted. */
async function setup(page: Page, administrator = true) {
  let album = catalogAlbum(), review = catalogReview(), created = false, denied = false, finishAnalysis = false;
  const reads: string[] = [], writes: Write[] = [];
  const headers = { 'X-Finitude-Account-Viewer': viewer, 'Cache-Control': 'no-store' };
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort('blockedbyclient'));
  await page.route('**/auth/browser/session', route => route.fulfill({ json: { user: { ...session.user, role: administrator ? 'admin' : 'user' } } }));
  await page.route('**/api/listener/v1/capabilities', route => route.fulfill({ json: { playlists: false } }));
  await page.route('**/api/listener/v1/personalization-capabilities', route => route.fulfill({ json: { contractVersion: 1, deterministicDiscovery: false, artistFollows: false } }));
  await page.route('**/api/listener/v1/home', route => route.fulfill({ json: { title: 'Synthetic Home', sections: [] }, headers }));
  await page.route('**/content/me/playlists?limit=50', route => route.fulfill({ json: { items: [], nextCursor: null }, headers }));
  const receipt = (body: Record<string, unknown>, kind: CatalogReview['receipts'][number]['kind']) => {
    const value = { operationId: String(body.operationId), kind, revision: review.revision };
    review.receipts.push(value);
    return { item: review, receipt: value };
  };
  await page.route('**/api/admin/v1/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
    expect(request.headers()['x-finitude-account-viewer']).toBe(viewer);
    if (method === 'GET') reads.push(path);
    if (denied) return route.fulfill({ status: 403, json: { code: 'ADMIN_REQUIRED' }, headers });
    if (path.endsWith('/capabilities')) return route.fulfill({ json: { ...capabilities, catalog: { editing: true, visibility: true } }, headers });
    if (path === '/api/admin/v1/imports') return route.fulfill({ json: { items: [], counts: { all: 0, analyzing: 0, awaitingReview: 0, needsAttention: 0, completed: 0 }, nextCursor: null }, headers });
    if (path === '/api/admin/v1/catalog/album') return route.fulfill({ json: { items: [album], nextCursor: null }, headers });
    if (path === `/api/admin/v1/catalog/album/${albumId}/cover-operations`) return route.fulfill({ json: { items: [] }, headers });
    if (path === `/api/admin/v1/catalog/album/${albumId}`) {
      if (method === 'GET') return route.fulfill({ json: { item: album }, headers });
      expect(method).toBe('PATCH');
      const body = request.postDataJSON(); writes.push({ path, method, body });
      expect(body.expectedRevision).toBe(album.revision);
      album = { ...album, revision: `cr_${'b'.repeat(43)}`, fields: { ...album.fields, ...body.fields } };
      return route.fulfill({ json: { item: album, receipt: { operationId: body.operationId } }, headers });
    }
    if (path === '/api/admin/v1/catalog-reviews') {
      if (method === 'GET') {
        const counts = { all: created ? 1 : 0, analyzing: created && ['queued', 'running'].includes(review.analysis.state) ? 1 : 0,
          awaitingReview: created && review.state === 'reviewing' ? 1 : 0, needsAttention: 0, completed: created && review.state === 'applied' ? 1 : 0 };
        return route.fulfill({ json: { items: created ? [{ id: review.id, revision: review.revision, createdAt: review.createdAt, updatedAt: review.updatedAt, startedByMe: review.startedByMe,
          state: review.state, analysis: review.analysis, albumId, title: review.source.album.title, pendingSuggestions: review.suggestions.filter(value => value.decision === 'pending').length }] : [], counts, nextCursor: null }, headers });
      }
      expect(method).toBe('POST');
      const body = request.postDataJSON(); writes.push({ path, method, body });
      expect(body).toMatchObject({ albumId, expectedRevision: album.revision });
      const fixture = catalogReview();
      review = { ...fixture, source: { ...fixture.source, album: { ...fixture.source.album, title: album.fields.title, revision: album.revision } },
        draft: { ...fixture.draft, album: { ...fixture.draft.album, title: album.fields.title } },
        analysis: { ...fixture.analysis, state: 'idle', generation: 0, operationId: null, completedChunks: 0, totalChunks: 0, attemptsUsed: 0 }, suggestions: [] };
      created = true;
      return route.fulfill({ status: 201, json: receipt(body, 'create'), headers });
    }
    if (path === `/api/admin/v1/catalog-reviews/${reviewId}`) {
      if (method === 'GET') {
        if (finishAnalysis && review.analysis.state === 'queued') {
          review.analysis = { ...review.analysis, state: 'complete', completedChunks: 2, totalChunks: 2, attemptsUsed: 2 };
          review.suggestions = catalogReview().suggestions.map(value => value.id === titleSuggestionId ? { ...value, baseline: review.source.album.title } : value);
          review.revision++;
        }
        return route.fulfill({ json: { item: review, receipt: null }, headers });
      }
      expect(method).toBe('PATCH');
      const body = request.postDataJSON(); writes.push({ path, method, body });
      expect(body.expectedRevision).toBe(review.revision);
      review = { ...review, revision: review.revision + 1, draft: body.draft };
      return route.fulfill({ json: receipt(body, 'edit'), headers });
    }
    if (path.startsWith(`/api/admin/v1/catalog-reviews/${reviewId}/`) && method === 'POST') {
      const body = request.postDataJSON(); writes.push({ path, method, body });
      expect(body.expectedRevision).toBe(review.revision);
      if (path.endsWith('/analyze')) {
        review = { ...review, revision: review.revision + 1, analysis: { ...review.analysis, state: 'queued', generation: 1, operationId: body.operationId } };
        return route.fulfill({ status: 202, json: receipt(body, 'analyze'), headers });
      }
      if (path.endsWith('/adopt')) {
        expect(body.selectedIds).toEqual([titleSuggestionId]); expect(body.rejectIds).toEqual([]);
        const selected = review.suggestions.find(value => value.id === titleSuggestionId)!;
        review = { ...review, revision: review.revision + 1, draft: { ...review.draft, album: { ...review.draft.album, title: String(selected.value) } },
          suggestions: review.suggestions.map(value => value.id === titleSuggestionId ? { ...value, decision: 'accepted' } : value) };
        return route.fulfill({ json: receipt(body, 'adopt'), headers });
      }
      expect(path.endsWith('/apply')).toBe(true);
      expect(body.fields).toEqual([{ scope: 'album', slotId: null, field: 'title' }]);
      expect(review.sourceStatus).toBe('current');
      album = { ...album, revision: `cr_${'c'.repeat(43)}`, fields: { ...album.fields, title: review.draft.album.title } };
      review = { ...review, revision: review.revision + 1, state: 'applied', capabilities: { analysis: false, apply: false },
        applied: { operationId: body.operationId, at: '2026-10-14T00:00:00.000Z', fields: body.fields } };
      return route.fulfill({ json: receipt(body, 'apply'), headers });
    }
    throw new Error(`Unexpected synthetic administrator request: ${method} ${path}`);
  });
  return { reads, writes, album: () => album, review: () => review, finish: () => { finishAnalysis = true; }, revoke: () => { denied = true; },
    ready: () => { created = true; }, changeSource: (reason: 'metadata' | 'media') => {
      if (reason === 'metadata') album = { ...album, revision: `cr_${'d'.repeat(43)}`, fields: { ...album.fields, title: 'Externally renamed Album' } };
      review = { ...review, sourceStatus: 'changed', capabilities: { ...review.capabilities, apply: false } };
    }, externalDraft: () => { review = { ...review, revision: review.revision + 1, draft: { ...review.draft, album: { ...review.draft.album, title: 'Another saved review value' } } }; }
  };
}

async function enter(page: Page, path: string) {
  await page.goto(path);
  await page.getByRole('button', { name: 'Switch to Admin view', exact: true }).click();
}
async function capture(page: Page, name: string, width: number, fullPage = true, top = true) {
  await mkdir(shots, { recursive: true });
  await expect(page.getByRole('status').filter({ hasText: /^Loading…$/ })).toHaveCount(0);
  if (top) await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: `${shots}/${name}-${width}.png`, fullPage });
}
async function reflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.body.scrollWidth <= window.innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
}

for (const width of [1280, 390]) {
  test(`existing Album manual editing and selective durable Luna review stay separate at ${width}px`, async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width, height: width === 1280 ? 720 : 844 });
    const api = await setup(page);
    await enter(page, '/finitude/admin/imports');
    await expect(page.getByRole('link', { name: 'Manage published Albums' })).toBeVisible();
    await expect(page.getByText('No projects yet. Create an Album draft to begin.')).toBeVisible();
    await capture(page, '01-workbench', width); await reflow(page);
    await page.getByRole('link', { name: 'Manage published Albums' }).click();
    await expect(page.getByRole('link', { name: 'Edit manually' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Review existing Album' })).toBeVisible();
    expect(api.writes).toEqual([]);
    await capture(page, '02-catalog-entry', width); await reflow(page);
    await page.getByRole('link', { name: 'Edit manually' }).click();
    await page.getByRole('textbox', { name: 'Title', exact: true }).fill('Manually corrected synthetic Album');
    await expect(page.getByRole('heading', { name: 'Content details', exact: true })).toBeVisible();
    await capture(page, '02b-manual-editor', width);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    const manual = page.getByRole('dialog', { name: 'Confirm catalog changes' });
    await expect(manual.getByRole('heading', { name: 'Confirm catalog changes', exact: true })).toBeVisible();
    await expect(manual.getByText('Manually corrected synthetic Album', { exact: true })).toBeVisible();
    expect(api.writes).toEqual([]);
    await capture(page, '03-manual-confirmation', width, false); await reflow(page);
    await manual.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Manually corrected synthetic Album', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    expect(api.writes).toHaveLength(1); expect(api.writes[0]).toMatchObject({ path: `/api/admin/v1/catalog/album/${albumId}`, method: 'PATCH', body: { fields: { title: 'Manually corrected synthetic Album' } } });
    await page.getByRole('navigation', { name: 'Workbench', exact: true }).getByRole('link', { name: 'Catalog', exact: true }).click();
    await page.getByRole('button', { name: 'Review existing Album' }).click();
    const creation = page.getByRole('dialog', { name: 'Review existing Album' });
    await expect(creation.getByRole('heading', { name: 'Review existing Album', exact: true })).toBeVisible();
    await expect(creation.getByText('Manually corrected synthetic Album', { exact: true })).toBeVisible();
    expect(api.writes).toHaveLength(1);
    await capture(page, '04-create-confirmation', width, false);
    await creation.getByRole('button', { name: 'Create review project' }).click();
    await expect(page).toHaveURL(new RegExp(`/finitude/admin/catalog-reviews/${reviewId}$`));
    await expect(page.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('Manually corrected synthetic Album');
    await expect(page.getByRole('textbox', { name: 'Artist name', exact: true })).toHaveAttribute('readonly', '');
    expect(api.writes.map(value => value.path)).toEqual([`/api/admin/v1/catalog/album/${albumId}`, '/api/admin/v1/catalog-reviews']);
    await capture(page, '05-review-draft', width); await reflow(page);
    await page.getByRole('button', { name: 'Analyze', exact: true }).click();
    const analysis = page.getByRole('dialog', { name: 'Start Luna review' });
    await expect(analysis.getByRole('heading', { name: 'Start Luna review', exact: true })).toBeVisible();
    await expect(analysis.getByText('Manually corrected synthetic Album', { exact: true })).toBeVisible();
    await expect(analysis.getByRole('button', { name: 'Start Luna review', exact: true })).toBeVisible();
    expect(api.writes.filter(value => value.path.endsWith('/analyze'))).toHaveLength(0);
    await capture(page, '06-luna-confirmation', width, false);
    await analysis.getByRole('button', { name: 'Start Luna review' }).click();
    await expect(page.getByRole('button', { name: 'Stop analysis' })).toBeVisible();
    expect(api.writes.filter(value => value.path.endsWith('/analyze'))).toHaveLength(1);
    await page.reload(); await page.getByRole('button', { name: 'Switch to Admin view' }).click();
    await expect(page.getByRole('button', { name: 'Stop analysis' })).toBeVisible();
    expect(api.writes.filter(value => value.path.endsWith('/analyze'))).toHaveLength(1);
    api.finish(); await page.getByRole('button', { name: 'Refresh status' }).click();
    await expect(page.getByRole('button', { name: 'Analyze again' })).toBeVisible();
    await page.getByRole('tab', { name: 'Review', exact: true }).click();
    const suggestion = page.getByRole('article').filter({ has: page.getByRole('checkbox', { name: 'Title', exact: true }) });
    await expect(suggestion.getByText('When analyzed', { exact: true })).toBeVisible();
    await expect(suggestion.getByText('Current draft', { exact: true })).toBeVisible();
    await expect(suggestion.getByText('Luna suggestion', { exact: true })).toBeVisible();
    await expect(suggestion.getByText('Reviewed synthetic Album', { exact: true })).toBeVisible();
    await capture(page, '07-review-diff', width); await reflow(page);
    await suggestion.scrollIntoViewIfNeeded();
    await suggestion.screenshot({ path: `${shots}/07b-review-diff-card-${width}.png` });
    await capture(page, '07c-review-diff-viewport', width, false, false);
    await page.getByRole('checkbox', { name: 'Title', exact: true }).check();
    await page.getByRole('button', { name: 'Apply selected', exact: true }).click();
    await page.getByRole('tab', { name: 'Draft', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('Reviewed synthetic Album');
    await expect(page.getByRole('textbox', { name: '1 · Title', exact: true })).toHaveValue('Synthetic first track');
    await page.getByRole('spinbutton', { name: '2 · Track number', exact: true }).fill('7');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Saved to private review', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    expect(api.album().fields.title).toBe('Manually corrected synthetic Album');
    await page.getByRole('tab', { name: 'Apply changes' }).click();
    await page.getByRole('checkbox', { name: 'Apply Manually corrected synthetic Album · Title', exact: true }).check();
    await expect(page.getByRole('checkbox', { name: 'Apply Synthetic second track · Track number', exact: true })).not.toBeChecked();
    await capture(page, '08-review-apply', width); await reflow(page);
    await page.getByRole('button', { name: 'Apply selected changes' }).click();
    const application = page.getByRole('dialog', { name: 'Confirm catalog changes' });
    await expect(application.getByRole('heading', { name: 'Confirm catalog changes', exact: true })).toBeVisible();
    await expect(application.getByText('Manually corrected synthetic Album', { exact: true })).toBeVisible();
    await expect(application.getByText('Selected changes: 1', { exact: true })).toBeVisible();
    await expect(application.getByRole('button', { name: 'Apply selected changes', exact: true })).toBeVisible();
    expect(api.writes.filter(value => value.path.endsWith('/apply'))).toHaveLength(0);
    await capture(page, '09-apply-confirmation', width, false); await reflow(page);
    await application.getByRole('button', { name: 'Apply selected changes' }).click();
    await expect(page.getByRole('heading', { name: 'Changes applied to the existing Album' })).toBeVisible();
    expect(api.album().id).toBe(albumId); expect(api.album().fields.title).toBe('Reviewed synthetic Album');
    expect(api.review().source.tracks.find(value => value.slotId === slotTwo)?.trackNumber).toBeNull();
    expect(api.writes.some(value => /\/imports|\/publish|\/assets\//.test(value.path))).toBe(false);
    await page.getByRole('tab', { name: 'Draft', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Title', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    await capture(page, '10-readonly-review', width);
    await page.getByRole('link', { name: 'Back to workbench' }).click();
    await expect(page).toHaveURL(/source=catalogReviews/);
    await expect(page.getByRole('heading', { name: 'Workbench', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Catalog reviews', exact: true })).toHaveAttribute('aria-pressed', 'true');
    const reviewCard = page.getByRole('listitem').filter({ has: page.getByRole('link', { name: 'Open review', exact: true }) });
    await expect(reviewCard.getByText('Changes applied to the existing Album', { exact: true })).toBeVisible();
    await capture(page, '11-review-queue', width); await reflow(page);
    const calls = api.writes.filter(value => value.path.endsWith('/analyze')).length;
    await page.getByRole('link', { name: 'Open review' }).click();
    await expect(page.getByRole('heading', { name: 'Changes applied to the existing Album' })).toBeVisible();
    expect(api.writes.filter(value => value.path.endsWith('/analyze'))).toHaveLength(calls);
    await page.getByRole('link', { name: 'Edit published Album' }).click();
    await expect(page.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('Reviewed synthetic Album');
  });
}

test('manual catalog confirmation cannot rebase onto a newer Album revision', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const api = await setup(page);
  await enter(page, `/finitude/admin/catalog/album/${albumId}`);
  await page.getByRole('textbox', { name: 'Title', exact: true }).fill('Frozen manual correction');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm catalog changes' });
  api.changeSource('metadata');
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
  await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await expect(dialog.getByText('Frozen manual correction', { exact: true })).toBeVisible();
  await capture(page, '15-manual-stale-confirmation', 1280, false);
  expect(api.writes).toEqual([]);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Discard local edits and load saved version' }).click();
  await expect(page.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('Externally renamed Album');
  await page.getByRole('textbox', { name: 'Title', exact: true }).fill('Newly reviewed manual correction');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Newly reviewed manual correction', exact: true })).toBeVisible();
  expect(api.writes).toHaveLength(1);
  expect(api.writes[0]).toMatchObject({ path: `/api/admin/v1/catalog/album/${albumId}`, method: 'PATCH', body: { expectedRevision: `cr_${'d'.repeat(43)}`, fields: { title: 'Newly reviewed manual correction' } } });
});

test('changed source media and stale confirmations cannot silently rebase catalog application', async ({ page }) => {
  const api = await setup(page); api.ready();
  await enter(page, `/finitude/admin/catalog-reviews/${reviewId}`);
  await page.getByRole('textbox', { name: 'Title', exact: true }).fill('Private manual correction');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved to private review', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await page.getByRole('tab', { name: 'Apply changes' }).click();
  await page.getByRole('checkbox', { name: 'Apply Synthetic catalog Album · Title', exact: true }).check();
  await page.getByRole('button', { name: 'Apply selected changes' }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm catalog changes' });
  api.externalDraft();
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
  await expect(dialog.getByRole('button', { name: 'Apply selected changes' })).toBeDisabled();
  await expect(dialog.getByText('Synthetic catalog Album', { exact: true })).toBeVisible();
  expect(api.writes.filter(value => value.path.endsWith('/apply'))).toHaveLength(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('checkbox', { name: 'Apply Synthetic catalog Album · Title', exact: true })).not.toBeChecked();
  await expect(page.getByText('Another saved review value', { exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: 'Apply Synthetic catalog Album · Title', exact: true }).check();
  await page.getByRole('button', { name: 'Apply selected changes' }).click();
  await expect(dialog.getByRole('button', { name: 'Apply selected changes' })).toBeEnabled();
  api.changeSource('media');
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
  await expect(dialog.getByRole('button', { name: 'Apply selected changes' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('alert')).toHaveText('The Album, its tracks or a source file has changed. Open the current Album and create a new review before applying changes.');
  await expect(page.getByRole('button', { name: 'Apply selected changes' })).toBeDisabled();
  expect(api.writes.filter(value => value.path.endsWith('/apply'))).toHaveLength(0);
});

test('changed metadata remains reviewable but cannot be applied and 640px reflow stays accessible', async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 844 });
  const api = await setup(page); api.ready();
  await enter(page, `/finitude/admin/catalog-reviews/${reviewId}`);
  await page.getByRole('textbox', { name: 'Title', exact: true }).fill('Reviewed metadata before another admin edit');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved to private review', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await capture(page, '12-reflow-draft', 640); await reflow(page);
  await page.getByRole('tab', { name: 'Apply changes' }).click();
  await page.getByRole('checkbox', { name: 'Apply Synthetic catalog Album · Title', exact: true }).check();
  await page.getByRole('button', { name: 'Apply selected changes' }).click();
  await capture(page, '13-reflow-confirmation', 640, false); await reflow(page);
  await page.keyboard.press('Escape');
  api.changeSource('metadata'); await page.getByRole('button', { name: 'Refresh status' }).click();
  await expect(page.getByRole('button', { name: 'Apply selected changes' })).toBeDisabled();
  await expect(page.getByRole('checkbox', { name: 'Apply Synthetic catalog Album · Title', exact: true })).toBeDisabled();
  await capture(page, '14-source-changed', 640); await reflow(page);
  expect(api.writes.filter(value => value.path.endsWith('/apply'))).toHaveLength(0);
});

test('User view and revoked role remove private reviews and stop their requests', async ({ page }) => {
  const api = await setup(page); api.ready();
  await enter(page, `/finitude/admin/catalog-reviews/${reviewId}`);
  await expect(page.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('Synthetic catalog Album');
  await page.getByRole('button', { name: 'Current view: Admin' }).click();
  await page.getByRole('button', { name: 'User', exact: true }).click();
  await expect(page).toHaveURL(/\/finitude\/?$/);
  const afterUser = api.reads.filter(path => path.includes('/catalog-reviews')).length;
  await page.goto(`/finitude/admin/catalog-reviews/${reviewId}`);
  await expect(page.getByText('Switch to Admin view to open the workbench. Current administrator access is required.')).toBeVisible();
  expect(api.reads.filter(path => path.includes('/catalog-reviews'))).toHaveLength(afterUser);
  await expect(page.getByRole('textbox', { name: 'Title', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Switch to Admin view' }).click();
  await expect(page.getByRole('textbox', { name: 'Title', exact: true })).toBeVisible();
  api.revoke(); await page.getByRole('button', { name: 'Refresh status' }).click();
  await expect(page.getByRole('textbox', { name: 'Title', exact: true })).toHaveCount(0);
  const afterLoss = api.reads.filter(path => path.includes('/catalog-reviews')).length;
  await page.goto(`/finitude/admin/catalog-reviews/${reviewId}`);
  await expect(page.getByText('Switch to Admin view to open the workbench. Current administrator access is required.')).toBeVisible();
  expect(api.reads.filter(path => path.includes('/catalog-reviews'))).toHaveLength(afterLoss);
  expect(api.writes).toEqual([]);
});

test('an ordinary account never requests private catalog reviews', async ({ page }) => {
  const api = await setup(page, false);
  await page.goto(`/finitude/admin/catalog-reviews/${reviewId}`);
  await expect(page.getByText('Switch to Admin view to open the workbench. Current administrator access is required.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Switch to Admin view' })).toHaveCount(0);
  expect(api.reads).toEqual([]); expect(api.writes).toEqual([]);
});
