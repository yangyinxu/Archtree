import { expect, test, type Page } from '@playwright/test';
import sharp from 'sharp';
import { createTestVideo } from './fixtures/audio';
import { fulfillMedia } from './support/apiRoutes';
import { capabilities, session, viewer } from '../src/features/admin/adminFixtures.testSupport';
import { videoProject, videoProjectId } from '../src/features/admin/videoUploadFixtures.testSupport';
import type { CatalogItem } from '../src/features/admin/catalogApi';

const id = 'dddddddddddddddddddddddd', mediaPath = `/api/admin/v1/catalog/audioTrack/${id}/media`, artworkPath = `/api/admin/v1/catalog/audioTrack/${id}/artwork`;
const videoBytes = createTestVideo();

/** Uses a completed private history and independently current catalog data through the production CSP. */
async function setup(page: Page) {
  const project = videoProject(); project.stage = 'complete'; project.source.status = 'deleted'; project.draft.title = 'Frozen upload title';
  project.publication = { state: 'complete', operationId: project.source.operationId, mediaTrackId: id, coverUrl: `${artworkPath}?historical=1`, issue: null, cleanupPending: false };
  let item: Extract<CatalogItem, { kind: 'audioTrack' }> = { kind: 'audioTrack', mediaType: 'video', id, revision: `cr_${'a'.repeat(43)}`, visibility: 'public', effectiveVisibility: 'public', coverUrl: artworkPath, mediaUrl: mediaPath, capabilities: { editing: true, visibility: true }, fields: { title: 'Current published Video', releaseDate: null, credits: [], attributionStatus: 'unknown', discNumber: null, trackNumber: null } };
  const cover = await sharp({ create: { width: 160, height: 90, channels: 3, background: '#247040' } }).jpeg().toBuffer();
  const headers = { 'X-Finitude-Account-Viewer': viewer, 'Cache-Control': 'no-store' };
  const uploads: Buffer[] = [], changes: string[] = [];
  let historicalReads = 0, mediaReads = 0;
  await page.route('**/auth/browser/session', route => route.fulfill({ json: session }));
  await page.route('**/api/listener/v1/capabilities', route => route.fulfill({ json: { playlists: false } }));
  await page.route('**/api/listener/v1/personalization-capabilities', route => route.fulfill({ json: { contractVersion: 1, deterministicDiscovery: false, artistFollows: false } }));
  await page.route('**/api/admin/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (url.searchParams.has('historical') || path.startsWith(`/api/admin/v1/video-projects/${videoProjectId}/covers/`)) { historicalReads++; return route.fulfill({ status: 404, headers }); }
    if (path === mediaPath) { mediaReads++; expect(url.searchParams.get('viewer')).toBe(viewer); return fulfillMedia(route, videoBytes, 'video/webm'); }
    if (path === artworkPath) { expect(url.searchParams.get('viewer')).toBe(viewer); return route.fulfill({ status: item.coverUrl ? 200 : 404, body: item.coverUrl ? cover : undefined, contentType: 'image/jpeg', headers }); }
    expect(request.headers()['x-finitude-account-viewer']).toBe(viewer);
    if (path.endsWith('/capabilities')) return route.fulfill({ json: { ...capabilities, catalog: { editing: true, visibility: true }, videoUploads: { enabled: true, maxFileBytes: 512 * 1024 ** 2, acceptedExtensions: ['mp4', 'mov', 'm4v'] } }, headers });
    if (path === `/api/admin/v1/video-projects/${videoProjectId}`) return route.fulfill({ json: { schemaVersion: 1, item: project }, headers });
    if (path.endsWith('/cover-operations')) return route.fulfill({ json: { items: [] }, headers });
    if (path.endsWith('/cover-uploads') && request.method() === 'POST') {
      const bytes = request.postDataBuffer()!; uploads.push(bytes);
      expect(bytes.indexOf(Buffer.from([255, 216, 255]))).toBeGreaterThan(0);
      return route.fulfill({ json: { upload: { id: 'cccccccccccccccccccccccc' }, receipt: { operationId: request.headers()['idempotency-key'] } }, headers });
    }
    if (path.endsWith('/cover') && ['POST', 'DELETE'].includes(request.method())) {
      changes.push(request.method()); return route.fulfill({ json: { item, receipt: { operationId: request.postDataJSON().operationId }, coverOperation: { state: 'complete', cleanupPending: false } }, headers });
    }
    if (path === `/api/admin/v1/catalog/audioTrack/${id}`) return route.fulfill({ json: { item }, headers });
    return route.fulfill({ status: 404, json: { code: 'SYNTHETIC_UNEXPECTED_ENDPOINT' }, headers });
  });
  await page.goto(`/finitude/admin/videos/${videoProjectId}`);
  await page.getByRole('button', { name: 'Switch to Admin view', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Video publication complete', exact: true })).toBeVisible();
  return { cover, uploads, changes, historicalReads: () => historicalReads, mediaReads: () => mediaReads,
    refreshCatalog() { item = { ...item, revision: `cr_${'b'.repeat(43)}`, coverUrl: null, fields: { ...item.fields, title: 'Updated current Video' } }; } };
}

/** An upload may wait behind the closing picker; either route requires a separate explicit approval. */
async function approval(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'Confirm catalog cover change', exact: true });
  const use = page.getByRole('button', { name: 'Use this image', exact: true });
  await expect.poll(async () => (await dialog.count()) + (await use.count())).toBeGreaterThan(0);
  if (await use.isVisible()) await use.click();
  await expect(dialog).toBeVisible(); return dialog;
}

test('a completed upload plays current published Video and all three cover actions retain separate confirmation', async ({ page }, testInfo) => {
  const flow = await setup(page), video = page.locator('video[aria-label="Private video preview"]');
  await expect(page.getByText('Current published Video', { exact: true })).toBeVisible(); await expect(video).toBeVisible();
  await expect(page.locator('audio')).toHaveCount(0); await expect(page.getByRole('button', { name: 'Reselect the same local file', exact: true })).toHaveCount(0);
  await expect.poll(() => video.evaluate(node => (node as HTMLVideoElement).videoWidth)).toBeGreaterThan(0);
  for (const name of ['Upload image', 'Choose a Video frame', 'Use Album cover or default image']) await expect(page.getByRole('button', { name, exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Choose a Video frame', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Choose a Video frame', exact: true });
  await expect(picker.locator('video')).toHaveAttribute('src', `${mediaPath}?viewer=${viewer}`);
  await expect(picker.getByRole('button', { name: 'Use this frame', exact: true })).toBeEnabled();
  await picker.getByRole('button', { name: 'Use this frame', exact: true }).click();
  const frameApproval = await approval(page); expect(flow.uploads).toHaveLength(1); expect(flow.changes).toEqual([]);
  await expect(frameApproval.getByRole('img', { name: 'Image to upload', exact: true })).toBeVisible();
  await frameApproval.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Use Album cover or default image', exact: true }).click();
  const clearApproval = await approval(page); await expect(clearApproval.getByRole('button', { name: 'Remove catalog cover', exact: true })).toBeEnabled();
  await clearApproval.getByRole('button', { name: 'Cancel', exact: true }).click(); expect(flow.changes).toEqual([]);
  await page.locator('input[type=file]').setInputFiles({ name: 'synthetic-published-cover.jpg', mimeType: 'image/jpeg', buffer: flow.cover });
  const imageApproval = await approval(page); expect(flow.uploads).toHaveLength(2); await expect(imageApproval.getByRole('button', { name: 'Replace catalog cover', exact: true })).toBeEnabled();
  await imageApproval.getByRole('button', { name: 'Cancel', exact: true }).click(); expect(flow.changes).toEqual([]); expect(flow.historicalReads()).toBe(0); expect(flow.mediaReads()).toBeGreaterThan(0);
  await page.screenshot({ path: testInfo.outputPath('published-video-current-controls.png'), fullPage: true });
});

test('current catalog refresh replaces historical cover and title, and leaving Admin releases published media', async ({ page }) => {
  const flow = await setup(page), video = page.locator('video[aria-label="Private video preview"]');
  await expect(page.getByAltText('Selected Video cover', { exact: true })).toBeVisible();
  const earlier = await video.elementHandle(); flow.refreshCatalog(); await page.getByRole('button', { name: 'Refresh video', exact: true }).click();
  await expect(page.getByText('Updated current Video', { exact: true })).toBeVisible(); await expect(page.getByText('Default image', { exact: true })).toBeVisible();
  await expect(page.getByAltText('Selected Video cover', { exact: true })).toHaveCount(0); await expect(video).not.toHaveAttribute('poster', /.+/);
  await expect.poll(() => earlier!.evaluate(node => { const media = node as HTMLVideoElement; return { connected: media.isConnected, paused: media.paused, source: media.hasAttribute('src') }; })).toEqual({ connected: false, paused: true, source: false });
  const current = await video.elementHandle();
  await page.getByRole('button', { name: 'Current view: Admin', exact: true }).click(); await page.getByRole('menuitemradio', { name: 'User', exact: true }).click();
  await expect(page.locator('video')).toHaveCount(0); await expect(page.getByText('Updated current Video', { exact: true })).toHaveCount(0);
  await expect.poll(() => current!.evaluate(node => { const media = node as HTMLVideoElement; return { connected: media.isConnected, paused: media.paused, source: media.hasAttribute('src') }; })).toEqual({ connected: false, paused: true, source: false });
  expect(flow.historicalReads()).toBe(0); expect(flow.changes).toEqual([]); expect(flow.uploads).toEqual([]);
});
