import { mkdir, writeFile } from 'node:fs/promises';
import { expect, test, type Locator, type Page } from '@playwright/test';
import english from '../../localization/locales/en-US.json' with { type: 'json' };
import chinese from '../../localization/locales/zh-Hans.json' with { type: 'json' };
import AxeBuilder from '@axe-core/playwright';
import { capabilities, session, viewer } from '../src/features/admin/adminFixtures.testSupport';
import { albumId, catalogAlbum, catalogReview, reviewId, slotTwo, titleSuggestionId } from '../src/features/admin/catalogReviewFixtures.testSupport';
import type { CatalogReview } from '../src/features/admin/catalogReviewApi';

const shots = process.env.FINITUDE_CATALOG_E2E_SCREENSHOTS_DIR ?? '/tmp/finitude-first-use-fixed-20261014';
type Locale = 'en-US' | 'zh-Hans';
let locale: Locale = 'en-US';
const localizedViewports = [{ width: 1280, locale: 'en-US' }, { width: 390, locale: 'en-US' }, { width: 1280, locale: 'zh-Hans' }, { width: 390, locale: 'zh-Hans' }] as const;

/** Use the shipped localization contract, including counts and names, for real language-switch coverage. */
function label(key: keyof typeof english, parameters: Record<string, string | number> = {}) {
  return (locale === 'zh-Hans' ? chinese[key] : english[key]).replace(/\{([^}]+)\}/g, (token, name: string) => String(parameters[name] ?? token));
}
test.beforeEach(() => { locale = 'en-US'; });
type Write = { path: string; method: string; body: Record<string, unknown> };

/** Only fabricated catalog data and route responses are used; no provider, storage or account is contacted. */
async function setup(page: Page, administrator = true, initialReleaseDate: { year: number; month: number | null; day: number | null } | null = null) {
  let album = catalogAlbum(), review = catalogReview(), created = false, denied = false, finishAnalysis = false;
  album.fields.releaseDate = initialReleaseDate;
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
      if (body.visibility !== undefined) expect(['public', 'hidden']).toContain(body.visibility);
      album = { ...album, revision: `cr_${'b'.repeat(43)}`, visibility: body.visibility ?? album.visibility,
        effectiveVisibility: body.visibility ?? album.effectiveVisibility, fields: { ...album.fields, ...body.fields } };
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
  if (locale === 'zh-Hans') {
    await page.getByRole('button', { name: english['language.button.change'].replace('{language}', 'English (United States)'), exact: true }).click();
    await page.getByRole('dialog', { name: english['language.dialog.title'] }).getByRole('radio', { name: '简体中文', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hans');
  }
  await expectStandaloneAdministration(page, 'user');
  await page.getByRole('button', { name: label('admin.view.switch_admin'), exact: true }).click();
  await expectStandaloneAdministration(page, 'admin');
}

/** A protected management route never exposes listener chrome, even before entering Admin view. */
async function expectStandaloneAdministration(page: Page, view?: 'admin' | 'user') {
  await expect(page.locator('main')).toHaveCount(1);
  await expect(page.getByRole('main')).toHaveCount(1);
  await expect(page.getByRole('main')).toBeVisible();
  for (const [role, key] of [
    ['navigation', 'shell.nav.primary_label'], ['search', 'shell.search.global_label'],
    ['searchbox', 'shell.search.field_label'], ['complementary', 'shell.sidebar.label'],
    ['complementary', 'shell.now_playing.details_label'], ['region', 'player.region.label'],
    ['group', 'player.controls.label']
  ] as const) await expect(page.getByRole(role, { name: label(key), exact: true })).toHaveCount(0);
  await expect(page.locator('#library-sidebar')).toBeHidden();
  await expect(page.locator('#now-playing-aside')).toBeHidden();
  await expect(page.getByRole('region', { name: label('player.region.label'), exact: true, includeHidden: true })).toBeHidden();
  if (view) await expect(page.getByRole('button', { name: label(view === 'admin' ? 'admin.view.current_admin' : 'admin.view.current_user'), exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth)).toBe(true);
}
test.afterEach(async ({ page }, result) => {
  if (result.status === 'passed' && new URL(page.url()).pathname.startsWith('/finitude/admin')) await expectStandaloneAdministration(page);
});
async function capture(page: Page, name: string, width: number, fullPage = true, top = true) {
  await mkdir(`${shots}/${locale}`, { recursive: true });
  await expect(page.getByRole('status').filter({ hasText: /^(Loading…|加载中…)$/ })).toHaveCount(0);
  if (top) await resetMainScroll(page);
  if (name === '05-review-draft' || name === '16-hundred-track-first-screen') {
    await saveDraftGeometry(page, name, width);
  }
  await page.screenshot({ path: `${shots}/${locale}/${name}-${width}.png`, fullPage, animations: 'disabled' });
}
async function resetMainScroll(page: Page) {
  await page.getByRole('main').evaluate(element => { element.scrollTop = 0; });
}

/** Record actual scroll and text bounds alongside first-screen screenshots for reviewable layout evidence. */
async function saveDraftGeometry(page: Page, name: string, width: number) {
  const main = await page.getByRole('main').evaluate(element => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight };
  });
  const controls: Record<string, unknown> = {};
  for (const [control, key] of [['start', 'admin.catalog_review.analysis_confirm'], ['refresh', 'admin.common.refresh'], ['save', 'admin.catalog_review.save_draft']] as const) {
    controls[control] = await page.getByRole('button', { name: label(key), exact: true }).evaluate(element => {
      const rect = element.getBoundingClientRect(), range = document.createRange();
      range.selectNodeContents(element);
      return { text: element.textContent, x: rect.x, y: rect.y, width: rect.width, height: rect.height,
        clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, whiteSpace: getComputedStyle(element).whiteSpace,
        textRects: Array.from(range.getClientRects(), value => ({ x: value.x, y: value.y, width: value.width, height: value.height })) };
    });
  }
  await writeFile(`${shots}/${locale}/${name}-${width}.json`, JSON.stringify({ viewport: page.viewportSize(), main, controls }, null, 2));
}

/** Visibility assertions alone do not prove an action can be discovered without scrolling. */
async function expectInFirstMainScreen(page: Page, action: Locator) {
  await expect(action).toBeVisible();
  const [main, button] = await Promise.all([page.getByRole('main').boundingBox(), action.boundingBox()]);
  expect(main).not.toBeNull(); expect(button).not.toBeNull();
  expect(await page.getByRole('main').evaluate(element => element.scrollTop)).toBe(0);
  expect(button!.y).toBeGreaterThanOrEqual(main!.y);
  expect(button!.y + button!.height).toBeLessThanOrEqual(main!.y + main!.height);
}

function titleChangeName(target: string) {
  return label('admin.catalog_review.select_field', { type: label('admin.catalog_review.target_album'), target, field: label('admin.field.title') });
}

/** The final confirmation must display the exact selected original and saved values. */
async function expectFrozenTitle(dialog: Locator, target: string, value: string) {
  const summary = dialog.getByRole('heading', { name: titleChangeName(target), exact: true }).locator('..');
  await expect(summary.getByText(label('admin.catalog_review.original_value'), { exact: true })).toBeVisible();
  await expect(summary.getByText(label('admin.catalog_review.saved_value'), { exact: true })).toBeVisible();
  await expect(summary.getByText(target, { exact: true })).toBeVisible();
  await expect(summary.getByText(value, { exact: true })).toBeVisible();
}

/** Direct catalog approval compares each frozen field without searching unrelated page text. */
async function expectManualChange(dialog: Locator, field: keyof typeof english, current: string, next: string) {
  const article = dialog.getByRole('article').filter({ has: dialog.page().getByRole('heading', { name: label(field), exact: true }) });
  await expect(article).toHaveCount(1);
  const oldValue = article.getByText(label('admin.catalog.current_value'), { exact: true }).locator('..');
  const newValue = article.getByText(label('admin.catalog_review.saved_value'), { exact: true }).locator('..');
  await expect(oldValue.getByText(current, { exact: true })).toBeVisible();
  await expect(newValue.getByText(next, { exact: true })).toBeVisible();
  return { article, oldValue, newValue };
}

async function editManualAlbum(page: Page, title: string) {
  await page.getByRole('textbox', { name: label('admin.field.title'), exact: true }).fill(title);
  for (const [part, value] of [['year', '2026'], ['month', '10'], ['day', '14']] as const) {
    await page.getByRole('spinbutton', { name: label(`admin.field.${part}`), exact: true }).fill(value);
  }
  await page.getByRole('combobox', { name: label('admin.field.visibility'), exact: true }).selectOption('hidden');
}

/** Long confirmations start at the first difference, while their footer remains independently scrollable. */
async function captureManualDialog(page: Page, dialog: Locator, name: string, width: number) {
  const geometry = await dialog.evaluate(element => ({ scrollTop: element.scrollTop, scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight, initialFocusIsDialog: document.activeElement === element }));
  expect(geometry.scrollTop).toBe(0);
  expect(geometry.initialFocusIsDialog).toBe(true);
  await expect(dialog.getByRole('heading', { name: label('admin.catalog.confirm'), exact: true })).toBeInViewport();
  const first = dialog.getByRole('article').first();
  await expect(first.getByRole('heading', { name: label('admin.field.title'), exact: true })).toBeInViewport();
  await expect(first.getByText(label('admin.catalog.current_value'), { exact: true })).toBeInViewport();
  await expect(first.getByText(label('admin.catalog_review.saved_value'), { exact: true })).toBeInViewport();
  await capture(page, name, width, false, false);
  await writeFile(`${shots}/${locale}/${name}-${width}.json`, JSON.stringify(geometry, null, 2));
  return geometry;
}
async function reflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.body.scrollWidth <= window.innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
}

for (const variant of localizedViewports) {
  const { width } = variant;
  test(`existing Album manual editing and selective durable Luna review stay separate at ${width}px ${variant.locale}`, async ({ page }) => {
    locale = variant.locale; test.setTimeout(60_000);
    await page.setViewportSize({ width, height: width === 1280 ? 720 : 844 });
    const api = await setup(page);
    await enter(page, '/finitude/admin/imports');
    await expect(page.getByRole('link', { name: label('admin.workbench.manage_albums') })).toBeVisible();
    await expect(page.getByText(label('admin.workbench.empty'))).toBeVisible();
    await expect(page.getByRole('link', { name: label('admin.workbench.choose_existing'), exact: true })).toBeVisible();
    await capture(page, '01-workbench', width); await reflow(page);
    await page.getByRole('link', { name: label('admin.workbench.choose_existing'), exact: true }).click();
    await expect(page.getByRole('link', { name: label('admin.catalog_review.manual_edit') })).toBeVisible();
    await expect(page.getByRole('button', { name: label('admin.catalog_review.create') })).toBeVisible();
    expect(api.writes).toEqual([]);
    await capture(page, '02-catalog-entry', width); await reflow(page);
    await page.getByRole('link', { name: label('admin.catalog_review.manual_edit') }).click();
    await page.getByRole('textbox', { name: label('admin.field.title'), exact: true }).fill('Manually corrected synthetic Album');
    await expect(page.getByRole('heading', { name: label('admin.layout.catalog_details'), exact: true })).toBeVisible();
    await capture(page, '02b-manual-editor', width);
    await page.getByRole('button', { name: label('admin.catalog.save'), exact: true }).click();
    const manual = page.getByRole('dialog', { name: label('admin.catalog.confirm') });
    await expect(manual.getByRole('heading', { name: label('admin.catalog.confirm'), exact: true })).toBeVisible();
    await expectManualChange(manual, 'admin.field.title', 'Synthetic catalog Album', 'Manually corrected synthetic Album');
    await expect(manual.getByRole('article').getByRole('heading')).toHaveText([label('admin.field.title')]);
    expect(api.writes).toEqual([]);
    await capture(page, '03-direct-catalog-confirmation', width, false);
    await reflow(page);
    await manual.getByRole('button', { name: label('admin.catalog.save'), exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Manually corrected synthetic Album', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: label('admin.catalog.save'), exact: true })).toBeDisabled();
    expect(api.writes).toHaveLength(1); expect(api.writes[0]).toMatchObject({ path: `/api/admin/v1/catalog/album/${albumId}`, method: 'PATCH', body: { fields: { title: 'Manually corrected synthetic Album' } } });
    await page.getByRole('navigation', { name: label('admin.workbench.title'), exact: true }).getByRole('link', { name: label('admin.catalog.title'), exact: true }).click();
    await page.getByRole('button', { name: label('admin.catalog_review.create') }).click();
    const creation = page.getByRole('dialog', { name: label('admin.catalog_review.create') });
    await expect(creation.getByRole('heading', { name: label('admin.catalog_review.create'), exact: true })).toBeVisible();
    await expect(creation.getByText('Manually corrected synthetic Album', { exact: true })).toBeVisible();
    expect(api.writes).toHaveLength(1);
    await creation.getByRole('button', { name: label('admin.catalog_review.create_confirm') }).click();
    await expect(page).toHaveURL(new RegExp(`/finitude/admin/catalog-reviews/${reviewId}$`));
    await expect(page.getByRole('textbox', { name: label('admin.field.title'), exact: true })).toHaveValue('Manually corrected synthetic Album');
    await expect(page.getByRole('textbox', { name: label('admin.field.artist_name'), exact: true })).toHaveAttribute('readonly', '');
    expect(api.writes.map(value => value.path)).toEqual([`/api/admin/v1/catalog/album/${albumId}`, '/api/admin/v1/catalog-reviews']);
    await capture(page, '05-review-draft', width); await reflow(page);
    const start = page.getByRole('button', { name: label('admin.catalog_review.analysis_confirm'), exact: true });
    await expectInFirstMainScreen(page, start);
    expect((await start.boundingBox())!.y).toBeLessThan((await page.getByRole('textbox', { name: `1 · ${label('admin.field.title')}`, exact: true }).boundingBox())!.y);
    await page.getByRole('tab', { name: label('admin.catalog_review.review_tab'), exact: true }).click();
    const empty = page.getByText(label('admin.catalog_review.empty_idle'), { exact: true });
    const nextStep = page.getByRole('button', { name: label('admin.catalog_review.draft_tab'), exact: true });
    await expect(empty).toBeVisible(); await nextStep.scrollIntoViewIfNeeded();
    await expect(nextStep).toBeInViewport();
    await capture(page, '05b-not-started-next-step', width, false, false);
    await nextStep.click();
    await expect(page.getByRole('tab', { name: label('admin.catalog_review.draft_tab'), exact: true })).toHaveAttribute('aria-selected', 'true');
    await start.scrollIntoViewIfNeeded(); await expect(start).toBeInViewport();
    const saveDraft = page.getByRole('button', { name: label('admin.catalog_review.save_draft'), exact: true });
    await saveDraft.scrollIntoViewIfNeeded(); await expect(saveDraft).toBeInViewport();
    await capture(page, '05c-review-editor-save', width, false, false);
    await start.click();
    const analysis = page.getByRole('dialog', { name: label('admin.catalog_review.analysis_confirm') });
    await expect(analysis.getByRole('heading', { name: label('admin.catalog_review.analysis_confirm'), exact: true })).toBeVisible();
    await expect(analysis.getByText('Manually corrected synthetic Album', { exact: true })).toBeVisible();
    await expect(analysis.getByRole('button', { name: label('admin.catalog_review.analysis_confirm'), exact: true })).toBeVisible();
    expect(api.writes.filter(value => value.path.endsWith('/analyze'))).toHaveLength(0);
    await capture(page, '06-luna-confirmation', width, false);
    await analysis.getByRole('button', { name: label('admin.catalog_review.analysis_confirm') }).click();
    await expect(page.getByRole('button', { name: label('admin.analysis.stop') })).toBeVisible();
    expect(api.writes.filter(value => value.path.endsWith('/analyze'))).toHaveLength(1);
    await page.reload(); await page.getByRole('button', { name: label('admin.view.switch_admin') }).click();
    await expect(page.getByRole('button', { name: label('admin.analysis.stop') })).toBeVisible();
    expect(api.writes.filter(value => value.path.endsWith('/analyze'))).toHaveLength(1);
    api.finish(); await page.getByRole('button', { name: label('admin.common.refresh') }).click();
    await expect(page.getByRole('button', { name: label('admin.catalog_review.analysis_again') })).toBeVisible();
    await page.getByRole('tab', { name: label('admin.catalog_review.review_tab'), exact: true }).click();
    const suggestion = page.getByRole('article').filter({ has: page.getByRole('checkbox', { name: label('admin.field.title'), exact: true }) });
    await expect(suggestion.getByText(label('admin.review.baseline'), { exact: true })).toBeVisible();
    await expect(suggestion.getByText(label('admin.review.current'), { exact: true })).toBeVisible();
    await expect(suggestion.getByText(label('admin.review.suggested'), { exact: true })).toBeVisible();
    await expect(suggestion.getByText('Reviewed synthetic Album', { exact: true })).toBeVisible();
    await reflow(page);
    await suggestion.scrollIntoViewIfNeeded();
    await suggestion.screenshot({ path: `${shots}/${locale}/07b-review-diff-card-${width}.png`, animations: 'disabled' });
    await page.getByRole('checkbox', { name: label('admin.field.title'), exact: true }).check();
    await page.getByRole('button', { name: label('admin.action.apply'), exact: true }).click();
    await page.getByRole('tab', { name: label('admin.catalog_review.draft_tab'), exact: true }).click();
    await expect(page.getByRole('textbox', { name: label('admin.field.title'), exact: true })).toHaveValue('Reviewed synthetic Album');
    await expect(page.getByRole('textbox', { name: `1 · ${label('admin.field.title')}`, exact: true })).toHaveValue('Synthetic first track');
    await page.getByRole('spinbutton', { name: `2 · ${label('admin.field.track_number')}`, exact: true }).fill('7');
    await page.getByRole('button', { name: label('admin.catalog_review.save_draft'), exact: true }).click();
    await expect(page.getByText(label('admin.catalog_review.draft_saved'), { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: label('admin.catalog_review.save_draft'), exact: true })).toBeDisabled();
    expect(api.album().fields.title).toBe('Manually corrected synthetic Album');
    await page.getByRole('tab', { name: label('admin.catalog_review.apply_tab') }).click();
    await page.getByRole('checkbox', { name: label('admin.catalog_review.select_field', { type: label('admin.catalog_review.target_album'), target: 'Manually corrected synthetic Album', field: label('admin.field.title') }), exact: true }).check();
    await expect(page.getByRole('checkbox', { name: label('admin.catalog_review.select_field', { type: label('admin.catalog_review.target_track'), target: 'Synthetic second track', field: label('admin.field.track_number') }), exact: true })).not.toBeChecked();
    await reflow(page);
    const change = page.getByRole('article').filter({ has: page.getByRole('checkbox', { name: titleChangeName('Manually corrected synthetic Album'), exact: true }) });
    await change.scrollIntoViewIfNeeded();
    await change.screenshot({ path: `${shots}/${locale}/08b-apply-diff-card-${width}.png`, animations: 'disabled' });
    await page.getByRole('button', { name: label('admin.catalog_review.apply_action', { count: 1 }) }).click();
    const application = page.getByRole('dialog', { name: label('admin.catalog_review.apply_confirm') });
    await expect(application.getByRole('heading', { name: label('admin.catalog_review.apply_confirm'), exact: true })).toBeVisible();
    await expect(application.getByText('Manually corrected synthetic Album', { exact: true }).first()).toBeVisible();
    await expect(application.getByText(label('admin.catalog_review.selected', { count: 1 }), { exact: true })).toBeVisible();
    await expectFrozenTitle(application, 'Manually corrected synthetic Album', 'Reviewed synthetic Album');
    await expect(application.getByRole('heading', { name: label('admin.catalog_review.select_field', { type: label('admin.catalog_review.target_track'), target: 'Synthetic second track', field: label('admin.field.track_number') }), exact: true })).toHaveCount(0);
    await expect(application.getByRole('button', { name: label('admin.catalog_review.apply_action', { count: 1 }), exact: true })).toBeVisible();
    expect(api.writes.filter(value => value.path.endsWith('/apply'))).toHaveLength(0);
    await capture(page, '09-apply-confirmation', width, false); await reflow(page);
    await application.getByRole('button', { name: label('admin.catalog_review.apply_action', { count: 1 }) }).click();
    await expect(page.getByRole('heading', { name: label('admin.catalog_review.applied') })).toBeVisible();
    expect(api.album().id).toBe(albumId); expect(api.album().fields.title).toBe('Reviewed synthetic Album');
    expect(api.review().source.tracks.find(value => value.slotId === slotTwo)?.trackNumber).toBeNull();
    expect(api.writes.some(value => /\/imports|\/publish|\/assets\//.test(value.path))).toBe(false);
    await page.getByRole('tab', { name: label('admin.catalog_review.draft_tab'), exact: true }).click();
    await expect(page.getByRole('textbox', { name: label('admin.field.title'), exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: label('admin.catalog_review.save_draft'), exact: true })).toBeDisabled();
    await page.getByRole('link', { name: label('admin.common.back') }).click();
    await expect(page).toHaveURL(/source=catalogReviews/);
    await expect(page.getByRole('heading', { name: label('admin.workbench.title'), exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: label('admin.workbench.review_source'), exact: true })).toHaveAttribute('aria-pressed', 'true');
    const reviewCard = page.getByRole('listitem').filter({ has: page.getByRole('link', { name: label('admin.workbench.open_review'), exact: true }) });
    await expect(reviewCard.getByText(label('admin.catalog_review.applied'), { exact: true })).toBeVisible();
    await expect(reviewCard.getByText(label('admin.workbench.review_closed'), { exact: true })).toBeVisible();
    await expect(reviewCard.getByText(label('admin.workbench.review_updated'), { exact: true })).toBeVisible();
    await reviewCard.scrollIntoViewIfNeeded();
    await reviewCard.screenshot({ path: `${shots}/${locale}/11-review-queue-${width}.png`, animations: 'disabled' });
    await reflow(page);
    const calls = api.writes.filter(value => value.path.endsWith('/analyze')).length;
    await page.getByRole('link', { name: label('admin.workbench.open_review') }).click();
    await expect(page.getByRole('heading', { name: label('admin.catalog_review.applied') })).toBeVisible();
    expect(api.writes.filter(value => value.path.endsWith('/analyze'))).toHaveLength(calls);
    await page.getByRole('link', { name: label('admin.catalog_review.manage_original') }).click();
    await expect(page.getByRole('textbox', { name: label('admin.field.title'), exact: true })).toHaveValue('Reviewed synthetic Album');
  });
}

for (const width of [1280, 390]) {
  test(`100-track review keeps the paid start action discoverable without scrolling at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 1280 ? 720 : 844 });
    const api = await setup(page); api.ready();
    const item = api.review();
    item.source.tracks = Array.from({ length: 100 }, (_, index) => ({
      slotId: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      id: (index + 1).toString(16).padStart(24, '0'), revision: item.source.album.revision,
      title: `Synthetic track ${index + 1}`, trackNumber: index + 1,
      originalFileName: `${String(index + 1).padStart(2, '0')} Synthetic.mp3`
    }));
    item.draft.tracks = item.source.tracks.map(({ slotId, title, trackNumber }) => ({ slotId, title, trackNumber }));
    item.analysis = { ...item.analysis, state: 'idle', generation: 0, operationId: null, completedChunks: 0, totalChunks: 0, attemptsUsed: 0 };
    item.suggestions = [];
    await enter(page, `/finitude/admin/catalog-reviews/${reviewId}`);
    const start = page.getByRole('button', { name: label('admin.catalog_review.analysis_confirm'), exact: true });
    await capture(page, '16-hundred-track-first-screen', width, false);
    await expectInFirstMainScreen(page, start);
    await expect(start).toBeEnabled();
    const firstTrack = page.getByRole('textbox', { name: `1 · ${label('admin.field.title')}`, exact: true });
    await expect(page.getByRole('textbox', { name: `100 · ${label('admin.field.title')}`, exact: true })).toHaveCount(1);
    expect((await start.boundingBox())!.y).toBeLessThan((await firstTrack.boundingBox())!.y);
    await reflow(page);
    expect(api.writes).toEqual([]);
  });
}

for (const variant of localizedViewports) {
  const { width } = variant;
  test(`direct catalog confirmation shows ordered frozen title, date and visibility changes at ${width}px ${variant.locale}`, async ({ page }) => {
    locale = variant.locale;
    await page.setViewportSize({ width, height: width === 1280 ? 720 : 844 });
    const api = await setup(page, true, { year: 2024, month: null, day: null });
    await enter(page, `/finitude/admin/catalog/album/${albumId}`);
    await editManualAlbum(page, 'Manually corrected synthetic Album');
    await page.getByRole('button', { name: label('admin.catalog.save'), exact: true }).click();
    const dialog = page.getByRole('dialog', { name: label('admin.catalog.confirm') });
    await expect(dialog.getByRole('article').getByRole('heading')).toHaveText([
      label('admin.field.title'), label('admin.field.release_date'), label('admin.field.visibility')
    ]);
    await expectManualChange(dialog, 'admin.field.title', 'Synthetic catalog Album', 'Manually corrected synthetic Album');
    await expectManualChange(dialog, 'admin.field.release_date', '2024', '2026-10-14');
    await expectManualChange(dialog, 'admin.field.visibility', label('admin.field.public'), label('admin.field.hidden'));
    expect(api.writes).toEqual([]);
    await captureManualDialog(page, dialog, '20-direct-multiple-changes', width);
    await reflow(page);
    const approve = dialog.getByRole('button', { name: label('admin.catalog.save'), exact: true });
    await approve.scrollIntoViewIfNeeded();
    await expect(approve).toBeInViewport();
    await capture(page, '20b-direct-multiple-changes-actions', width, false, false);
    await approve.click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Manually corrected synthetic Album', exact: true })).toBeVisible();
    expect(api.writes).toHaveLength(1);
    expect(api.writes[0]).toMatchObject({ path: `/api/admin/v1/catalog/album/${albumId}`, method: 'PATCH', body: {
      expectedRevision: `cr_${'a'.repeat(43)}`, fields: { title: 'Manually corrected synthetic Album', releaseDate: { year: 2026, month: 10, day: 14 } }, visibility: 'hidden'
    } });
    expect(api.writes[0].body.fields).toEqual({ title: 'Manually corrected synthetic Album', releaseDate: { year: 2026, month: 10, day: 14 } });
    expect(api.album().visibility).toBe('hidden');
    expect(api.album().fields.credits).toBeNull();
  });

  test(`manual catalog stale confirmation explains recovery and preserves the draft at ${width}px ${variant.locale}`, async ({ page }) => {
    locale = variant.locale;
    await page.setViewportSize({ width, height: width === 1280 ? 720 : 844 });
    const api = await setup(page, true, { year: 2024, month: null, day: null });
    await enter(page, `/finitude/admin/catalog/album/${albumId}`);
    await editManualAlbum(page, 'Frozen manual correction');
    await page.getByRole('button', { name: label('admin.catalog.save'), exact: true }).click();
    const dialog = page.getByRole('dialog', { name: label('admin.catalog.confirm') });
    await expectManualChange(dialog, 'admin.field.title', 'Synthetic catalog Album', 'Frozen manual correction');
    api.changeSource('metadata');
    await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
    const warning = dialog.getByRole('alert');
    await expect(warning).toHaveText(label('admin.catalog.confirm_stale'));
    await expect(warning).toBeInViewport();
    await expect(dialog.getByRole('button', { name: label('admin.catalog.save'), exact: true })).toBeDisabled();
    await expectManualChange(dialog, 'admin.field.title', 'Synthetic catalog Album', 'Frozen manual correction');
    await expectManualChange(dialog, 'admin.field.release_date', '2024', '2026-10-14');
    await expectManualChange(dialog, 'admin.field.visibility', label('admin.field.public'), label('admin.field.hidden'));
    await expect(dialog.getByText('Externally renamed Album', { exact: true })).toHaveCount(0);
    await capture(page, '21-direct-stale-confirmation', width, false, false);
    await reflow(page);
    expect(api.writes).toEqual([]);
    await dialog.getByRole('button', { name: label('admin.common.cancel'), exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: label('admin.field.title'), exact: true })).toHaveValue('Frozen manual correction');
    await expect(page.getByRole('spinbutton', { name: label('admin.field.year'), exact: true })).toHaveValue('2026');
    await expect(page.getByRole('spinbutton', { name: label('admin.field.month'), exact: true })).toHaveValue('10');
    await expect(page.getByRole('spinbutton', { name: label('admin.field.day'), exact: true })).toHaveValue('14');
    await expect(page.getByRole('combobox', { name: label('admin.field.visibility'), exact: true })).toHaveValue('hidden');
    await page.getByRole('button', { name: label('admin.review.load_saved'), exact: true }).click();
    await expect(page.getByRole('textbox', { name: label('admin.field.title'), exact: true })).toHaveValue('Externally renamed Album');
    await expect(page.getByRole('spinbutton', { name: label('admin.field.year'), exact: true })).toHaveValue('2024');
    await expect(page.getByRole('spinbutton', { name: label('admin.field.month'), exact: true })).toHaveValue('');
    await expect(page.getByRole('combobox', { name: label('admin.field.visibility'), exact: true })).toHaveValue('public');
    await editManualAlbum(page, 'Newly reviewed manual correction');
    await page.getByRole('button', { name: label('admin.catalog.save'), exact: true }).click();
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    await expectManualChange(dialog, 'admin.field.title', 'Externally renamed Album', 'Newly reviewed manual correction');
    await expect(dialog.getByRole('button', { name: label('admin.catalog.save'), exact: true })).toBeEnabled();
    await captureManualDialog(page, dialog, '22-direct-refreshed-confirmation', width);
    expect(api.writes).toEqual([]);
    await dialog.getByRole('button', { name: label('admin.catalog.save'), exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Newly reviewed manual correction', exact: true })).toBeVisible();
    expect(api.writes).toHaveLength(1);
    expect(api.writes[0]).toMatchObject({ path: `/api/admin/v1/catalog/album/${albumId}`, method: 'PATCH', body: {
      expectedRevision: `cr_${'d'.repeat(43)}`, fields: { title: 'Newly reviewed manual correction', releaseDate: { year: 2026, month: 10, day: 14 } }, visibility: 'hidden'
    } });
  });
}

test('a long direct catalog confirmation starts at the first old/new field and keeps its actions reachable at 390px', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const api = await setup(page, true, { year: 2024, month: null, day: null });
  await enter(page, `/finitude/admin/catalog/album/${albumId}`);
  const longTitle = 'A synthetic independent recording with a deliberately long but valid Album title for readable confirmation testing. '.repeat(3).slice(0, 300);
  await editManualAlbum(page, longTitle);
  await page.getByRole('button', { name: label('admin.catalog.save'), exact: true }).click();
  const dialog = page.getByRole('dialog', { name: label('admin.catalog.confirm') });
  const title = await expectManualChange(dialog, 'admin.field.title', 'Synthetic catalog Album', longTitle);
  await expectManualChange(dialog, 'admin.field.release_date', '2024', '2026-10-14');
  await expectManualChange(dialog, 'admin.field.visibility', label('admin.field.public'), label('admin.field.hidden'));
  const geometry = await captureManualDialog(page, dialog, '23-long-direct-confirmation-top', 390);
  expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight);
  await expect(title.oldValue.getByText('Synthetic catalog Album', { exact: true })).toBeInViewport();
  await reflow(page);
  const approve = dialog.getByRole('button', { name: label('admin.catalog.save'), exact: true });
  await approve.scrollIntoViewIfNeeded();
  await expect(approve).toBeInViewport();
  await expect(dialog.getByRole('button', { name: label('admin.common.cancel'), exact: true })).toBeInViewport();
  await capture(page, '23b-long-direct-confirmation-actions', 390, false, false);
  expect(api.writes).toEqual([]);
  await dialog.getByRole('button', { name: label('admin.common.cancel'), exact: true }).click();
  await expect(page.getByRole('textbox', { name: label('admin.field.title'), exact: true })).toHaveValue(longTitle);
});

test('reverting catalog edits restores review and cover actions without issuing a catalog mutation', async ({ page }) => {
  const api = await setup(page);
  await enter(page, `/finitude/admin/catalog/album/${albumId}`);
  const title = page.getByRole('textbox', { name: label('admin.field.title'), exact: true });
  const save = page.getByRole('button', { name: label('admin.catalog.save'), exact: true });
  const review = page.getByRole('button', { name: label('admin.catalog_review.create'), exact: true });
  const cover = page.getByRole('button', { name: label('admin.cover.choose'), exact: true });
  await expect(save).toBeDisabled(); await expect(review).toBeEnabled(); await expect(cover).toBeEnabled();
  await title.fill('Temporary synthetic correction');
  await expect(save).toBeEnabled(); await expect(review).toBeDisabled(); await expect(cover).toBeDisabled();
  await expect(page.getByText(label('admin.catalog_review.save_first'), { exact: true })).toBeVisible();
  await title.fill('Synthetic catalog Album');
  await expect(save).toBeDisabled(); await expect(review).toBeEnabled(); await expect(cover).toBeEnabled();
  await expect(page.getByText(label('admin.catalog_review.save_first'), { exact: true })).toHaveCount(0);
  await review.click();
  const confirmation = page.getByRole('dialog', { name: label('admin.catalog_review.create') });
  await expect(confirmation.getByText('Synthetic catalog Album', { exact: true })).toBeVisible();
  await confirmation.getByRole('button', { name: label('admin.common.cancel'), exact: true }).click();
  await cover.click();
  await expect(page.getByRole('textbox', { name: label('admin.workbench.search'), exact: true })).toBeVisible();
  await expect.poll(() => api.reads.filter(path => path === '/api/admin/v1/imports').length).toBeGreaterThan(0);
  expect(api.writes).toEqual([]);
  await expect(title).toHaveValue('Synthetic catalog Album');
});

test('reverting an old catalog draft retains the recovery entry for a newer saved revision', async ({ page }) => {
  const api = await setup(page);
  await enter(page, `/finitude/admin/catalog/album/${albumId}`);
  const title = page.getByRole('textbox', { name: label('admin.field.title'), exact: true });
  const loadSaved = page.getByRole('button', { name: label('admin.review.load_saved'), exact: true });
  await title.fill('Temporary synthetic correction before an external edit');
  api.changeSource('metadata');
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
  await expect(loadSaved).toBeVisible();
  await expect(title).toHaveValue('Temporary synthetic correction before an external edit');
  await title.fill('Synthetic catalog Album');
  await expect(page.getByRole('alert')).toContainText(label('admin.common.conflict'));
  await expect(loadSaved).toBeVisible();
  await expect(page.getByRole('button', { name: label('admin.catalog.save'), exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: label('admin.catalog_review.create'), exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: label('admin.cover.choose'), exact: true })).toBeDisabled();
  await loadSaved.click();
  await expect(title).toHaveValue('Externally renamed Album');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: label('admin.catalog.save'), exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: label('admin.catalog_review.create'), exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: label('admin.cover.choose'), exact: true })).toBeEnabled();
  expect(api.writes).toEqual([]);
});

test('same-name credited Artists remain distinguishable in a mobile catalog confirmation', async ({ page }) => {
  locale = 'zh-Hans';
  await page.setViewportSize({ width: 390, height: 844 });
  const api = await setup(page);
  const oldArtistId = '555555555555555555555555', newArtistId = '666666666666666666666666';
  const name = 'Synthetic Same-name Artist';
  api.album().fields.credits = [{ creditId: 'synthetic-old-credit', subjectType: 'artist', subjectId: oldArtistId, role: 'primary', order: 0 }];
  api.album().fields.attributionStatus = 'documented';
  const artists = [oldArtistId, newArtistId].map(id => ({ kind: 'artist', id, revision: `cr_${'a'.repeat(43)}`,
    visibility: 'public', effectiveVisibility: 'public', coverUrl: null, mediaUrl: null,
    capabilities: { editing: true, visibility: true }, fields: { name, bio: '', birthDate: null } }));
  await page.route('**/api/admin/v1/catalog/artist**', route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    expect(request.method()).toBe('GET'); expect(request.headers()['x-finitude-account-viewer']).toBe(viewer);
    const headers = { 'X-Finitude-Account-Viewer': viewer, 'Cache-Control': 'no-store' };
    if (path === '/api/admin/v1/catalog/artist') return route.fulfill({ json: { items: artists, nextCursor: null }, headers });
    const item = artists.find(artist => path === `/api/admin/v1/catalog/artist/${artist.id}`);
    if (item) return route.fulfill({ json: { item }, headers });
    throw new Error(`Unexpected synthetic Artist read: ${path}`);
  });
  await enter(page, `/finitude/admin/catalog/album/${albumId}`);
  await page.getByRole('button', { name: label('admin.catalog.remove_credit'), exact: true }).click();
  await page.getByRole('textbox', { name: label('admin.catalog.search'), exact: true }).fill(name);
  await page.getByRole('button', { name: label('admin.catalog.search'), exact: true }).click();
  const candidates = page.getByRole('button', { name: `${label('admin.catalog.add_credit')} · ${name} · ${label('admin.field.public')}`, exact: true });
  await expect(candidates).toHaveCount(2);
  await candidates.nth(1).click();
  await page.getByRole('button', { name: label('admin.catalog.save'), exact: true }).click();
  const dialog = page.getByRole('dialog', { name: label('admin.catalog.confirm') });
  const credits = dialog.getByRole('article').filter({ has: page.getByRole('heading', { name: label('admin.catalog.credits'), exact: true }) });
  const oldValue = credits.getByText(label('admin.catalog.current_value'), { exact: true }).locator('..');
  const newValue = credits.getByText(label('admin.catalog_review.saved_value'), { exact: true }).locator('..');
  await expect(oldValue.getByRole('listitem')).toContainText(name);
  await expect(newValue.getByRole('listitem')).toContainText(name);
  await expect(oldValue.getByText(oldArtistId, { exact: true })).toHaveCount(0);
  await expect(newValue.getByText(newArtistId, { exact: true })).toHaveCount(0);
  await mkdir(`${shots}/${locale}`, { recursive: true });
  await credits.scrollIntoViewIfNeeded();
  await credits.screenshot({ path: `${shots}/${locale}/25-same-name-credits-collapsed-390.png`, animations: 'disabled' });
  await reflow(page);
  const oldSummary = oldValue.locator('summary'), newSummary = newValue.locator('summary');
  await expect(dialog).toBeFocused();
  await page.keyboard.press('Tab'); await expect(oldSummary).toBeFocused();
  await page.keyboard.press('Enter');
  const oldLink = oldValue.getByRole('link', { name: oldArtistId, exact: true });
  const newLink = newValue.getByRole('link', { name: newArtistId, exact: true });
  await expect(oldLink).toHaveAttribute('href', `/finitude/admin/catalog/artist/${oldArtistId}`);
  await expect(oldLink).toBeVisible();
  await page.keyboard.press('Tab'); await expect(oldLink).toBeFocused();
  await page.keyboard.press('Shift+Tab'); await expect(oldSummary).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: label('admin.catalog.save'), exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: label('admin.common.cancel'), exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab'); await expect(newSummary).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(newLink).toHaveAttribute('href', `/finitude/admin/catalog/artist/${newArtistId}`);
  await expect(newLink).toBeVisible();
  await page.keyboard.press('Tab'); await expect(newLink).toBeFocused();
  await credits.screenshot({ path: `${shots}/${locale}/25b-same-name-credits-expanded-390.png`, animations: 'disabled' });
  await reflow(page);
  expect(api.writes).toEqual([]);
  await dialog.getByRole('button', { name: label('admin.catalog.save'), exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(api.writes).toHaveLength(1);
  expect(api.writes[0]).toMatchObject({ path: `/api/admin/v1/catalog/album/${albumId}`, method: 'PATCH', body: {
    expectedRevision: `cr_${'a'.repeat(43)}`, fields: { attributionStatus: 'documented', credits: [{ subjectType: 'artist', subjectId: newArtistId, role: 'primary', order: 0 }] }
  } });
  expect(api.writes[0].body).not.toHaveProperty('visibility');
  expect(api.album().fields.title).toBe('Synthetic catalog Album');
});

test('changed source media and stale confirmations cannot silently rebase catalog application', async ({ page }) => {
  const api = await setup(page); api.ready();
  await enter(page, `/finitude/admin/catalog-reviews/${reviewId}`);
  await page.getByRole('textbox', { name: label('admin.field.title'), exact: true }).fill('Private manual correction');
  await page.getByRole('button', { name: label('admin.catalog_review.save_draft'), exact: true }).click();
  await expect(page.getByText(label('admin.catalog_review.draft_saved'), { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: label('admin.catalog_review.save_draft'), exact: true })).toBeDisabled();
  await page.getByRole('tab', { name: label('admin.catalog_review.apply_tab') }).click();
  await page.getByRole('checkbox', { name: label('admin.catalog_review.select_field', { type: label('admin.catalog_review.target_album'), target: 'Synthetic catalog Album', field: label('admin.field.title') }), exact: true }).check();
  await page.getByRole('button', { name: label('admin.catalog_review.apply_action', { count: 1 }) }).click();
  const dialog = page.getByRole('dialog', { name: label('admin.catalog_review.apply_confirm') });
  await expectFrozenTitle(dialog, 'Synthetic catalog Album', 'Private manual correction');
  api.externalDraft();
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
  await expect(dialog.getByRole('button', { name: label('admin.catalog_review.apply_action', { count: 1 }) })).toBeDisabled();
  await expectFrozenTitle(dialog, 'Synthetic catalog Album', 'Private manual correction');
  await expect(dialog.getByText('Another saved review value', { exact: true })).toHaveCount(0);
  expect(api.writes.filter(value => value.path.endsWith('/apply'))).toHaveLength(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('checkbox', { name: label('admin.catalog_review.select_field', { type: label('admin.catalog_review.target_album'), target: 'Synthetic catalog Album', field: label('admin.field.title') }), exact: true })).not.toBeChecked();
  await expect(page.getByText('Another saved review value', { exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: label('admin.catalog_review.select_field', { type: label('admin.catalog_review.target_album'), target: 'Synthetic catalog Album', field: label('admin.field.title') }), exact: true }).check();
  await page.getByRole('button', { name: label('admin.catalog_review.apply_action', { count: 1 }) }).click();
  await expect(dialog.getByRole('button', { name: label('admin.catalog_review.apply_action', { count: 1 }) })).toBeEnabled();
  await expectFrozenTitle(dialog, 'Synthetic catalog Album', 'Another saved review value');
  api.changeSource('media');
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
  await expect(dialog.getByRole('button', { name: label('admin.catalog_review.apply_action', { count: 1 }) })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('alert')).toHaveText(label('admin.catalog_review.source_changed'));
  await expect(page.getByRole('button', { name: label('admin.catalog_review.apply_action', { count: 1 }) })).toBeDisabled();
  expect(api.writes.filter(value => value.path.endsWith('/apply'))).toHaveLength(0);
});

test('multiple manual changes open confirmation at its first difference without applying the Album', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const api = await setup(page); api.ready();
  const item = api.review();
  item.analysis = { ...item.analysis, state: 'idle', generation: 0, operationId: null, completedChunks: 0, totalChunks: 0, attemptsUsed: 0 };
  item.suggestions = [];
  await enter(page, `/finitude/admin/catalog-reviews/${reviewId}`);
  await page.getByRole('textbox', { name: label('admin.field.title'), exact: true }).fill('Batch-reviewed synthetic Album');
  await page.getByRole('spinbutton', { name: `2 · ${label('admin.field.track_number')}`, exact: true }).fill('7');
  await page.getByRole('button', { name: label('admin.catalog_review.save_draft'), exact: true }).click();
  await expect(page.getByText(label('admin.catalog_review.draft_saved'), { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: label('admin.catalog_review.save_draft'), exact: true })).toBeDisabled();
  await page.getByRole('tab', { name: label('admin.catalog_review.apply_tab'), exact: true }).click();
  await page.getByRole('checkbox', { name: titleChangeName('Synthetic catalog Album'), exact: true }).check();
  await page.getByRole('checkbox', { name: label('admin.catalog_review.select_field', { type: label('admin.catalog_review.target_track'), target: 'Synthetic second track', field: label('admin.field.track_number') }), exact: true }).check();
  await page.getByRole('button', { name: label('admin.catalog_review.apply_action', { count: 2 }), exact: true }).click();
  const dialog = page.getByRole('dialog', { name: label('admin.catalog_review.apply_confirm') });
  // Footer focus would scroll a long summary past the first selected change before review begins.
  await expect(dialog).toBeFocused();
  await expect(dialog.getByRole('heading', { name: label('admin.catalog_review.apply_confirm'), exact: true })).toBeInViewport();
  await expect(dialog.getByText(label('admin.catalog_review.selected', { count: 2 }), { exact: true })).toBeInViewport();
  const first = dialog.getByRole('heading', { name: titleChangeName('Synthetic catalog Album'), exact: true }).locator('..');
  await expect(first.getByText('Synthetic catalog Album', { exact: true })).toBeInViewport();
  await expect(first.getByText('Batch-reviewed synthetic Album', { exact: true })).toBeInViewport();
  const geometry = await dialog.evaluate(element => ({ scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight }));
  expect(geometry.scrollTop).toBe(0);
  expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight);
  await capture(page, '17-multiple-changes-confirmation', 390, false, false);
  await writeFile(`${shots}/${locale}/17-multiple-changes-confirmation-390.json`, JSON.stringify(geometry, null, 2));
  await reflow(page);
  expect(api.writes).toHaveLength(1);
  expect(api.writes[0]).toMatchObject({ path: `/api/admin/v1/catalog-reviews/${reviewId}`, method: 'PATCH' });
  expect(api.writes.some(value => value.path.endsWith('/apply') || value.path.endsWith('/analyze'))).toBe(false);
  expect(api.album().fields.title).toBe('Synthetic catalog Album');
});

test('changed metadata remains reviewable but cannot be applied and 640px reflow stays accessible', async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 844 });
  const api = await setup(page); api.ready();
  await enter(page, `/finitude/admin/catalog-reviews/${reviewId}`);
  await page.getByRole('textbox', { name: label('admin.field.title'), exact: true }).fill('Reviewed metadata before another admin edit');
  await page.getByRole('button', { name: label('admin.catalog_review.save_draft'), exact: true }).click();
  await expect(page.getByText(label('admin.catalog_review.draft_saved'), { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: label('admin.catalog_review.save_draft'), exact: true })).toBeDisabled();
  await capture(page, '12-reflow-draft', 640); await reflow(page);
  await page.getByRole('tab', { name: label('admin.catalog_review.apply_tab') }).click();
  await page.getByRole('checkbox', { name: label('admin.catalog_review.select_field', { type: label('admin.catalog_review.target_album'), target: 'Synthetic catalog Album', field: label('admin.field.title') }), exact: true }).check();
  await page.getByRole('button', { name: label('admin.catalog_review.apply_action', { count: 1 }) }).click();
  await capture(page, '13-reflow-confirmation', 640, false); await reflow(page);
  await page.keyboard.press('Escape');
  api.changeSource('metadata'); await page.getByRole('button', { name: label('admin.common.refresh') }).click();
  await expect(page.getByRole('button', { name: label('admin.catalog_review.apply_action', { count: 1 }) })).toBeDisabled();
  await expect(page.getByRole('checkbox', { name: label('admin.catalog_review.select_field', { type: label('admin.catalog_review.target_album'), target: 'Synthetic catalog Album', field: label('admin.field.title') }), exact: true })).toBeDisabled();
  await capture(page, '14-source-changed', 640); await reflow(page);
  expect(api.writes.filter(value => value.path.endsWith('/apply'))).toHaveLength(0);
});

test('User view and revoked role remove private reviews and stop their requests', async ({ page }) => {
  const api = await setup(page); api.ready();
  await enter(page, `/finitude/admin/catalog-reviews/${reviewId}`);
  await expect(page.getByRole('textbox', { name: label('admin.field.title'), exact: true })).toHaveValue('Synthetic catalog Album');
  await page.getByRole('button', { name: 'Current view: Admin' }).click();
  await page.getByRole('button', { name: 'User', exact: true }).click();
  await expect(page).toHaveURL(/\/finitude\/?$/);
  const afterUser = api.reads.filter(path => path.includes('/catalog-reviews')).length;
  await page.goto(`/finitude/admin/catalog-reviews/${reviewId}`);
  await expect(page.getByText(label('admin.view.required'))).toBeVisible();
  expect(api.reads.filter(path => path.includes('/catalog-reviews'))).toHaveLength(afterUser);
  await expect(page.getByRole('textbox', { name: label('admin.field.title'), exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: label('admin.view.switch_admin') }).click();
  await expect(page.getByRole('textbox', { name: label('admin.field.title'), exact: true })).toBeVisible();
  api.revoke(); await page.getByRole('button', { name: label('admin.common.refresh') }).click();
  await expect(page.getByRole('textbox', { name: label('admin.field.title'), exact: true })).toHaveCount(0);
  const afterLoss = api.reads.filter(path => path.includes('/catalog-reviews')).length;
  await page.goto(`/finitude/admin/catalog-reviews/${reviewId}`);
  await expect(page.getByText(label('admin.view.required'))).toBeVisible();
  expect(api.reads.filter(path => path.includes('/catalog-reviews'))).toHaveLength(afterLoss);
  expect(api.writes).toEqual([]);
});

test('an ordinary account never requests private catalog reviews', async ({ page }) => {
  const api = await setup(page, false);
  await page.goto(`/finitude/admin/catalog-reviews/${reviewId}`);
  await expect(page.getByText(label('admin.view.required'))).toBeVisible();
  await expect(page.getByRole('button', { name: label('admin.view.switch_admin') })).toHaveCount(0);
  await expectStandaloneAdministration(page);
  expect(api.reads).toEqual([]); expect(api.writes).toEqual([]);
  await page.getByRole('banner').getByRole('link', { name: label('shell.brand.home_label'), exact: true }).click();
  await expect(page).toHaveURL(/\/finitude\/?$/);
  await expect(page.getByRole('navigation', { name: label('shell.nav.primary_label'), exact: true }).first()).toBeVisible();
  expect(api.reads).toEqual([]); expect(api.writes).toEqual([]);
});
