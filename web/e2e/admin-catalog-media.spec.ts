import { expect, test, type Page } from '@playwright/test';
import { createTestTone, createTestVideo } from './fixtures/audio';
import { fulfillMedia } from './support/apiRoutes';
import { capabilities, session, viewer } from '../src/features/admin/adminFixtures.testSupport';

const id = 'c'.repeat(24), mediaPath = `/api/admin/v1/catalog/audioTrack/${id}/media`;
const artworkPath = `/api/admin/v1/catalog/audioTrack/${id}/artwork`;
// Chromium's portable test runtime uses a real WebM clip; production AVC/HEVC admission is independent.
const videoBytes = createTestVideo(), audioBytes = createTestTone();
/** Private preview delivery keeps browser-native decode and account-viewer binding visible in the gate. */
async function setup(page: Page, mediaType: 'audio' | 'video' = 'video') {
  let previewRequests = 0;
  const item = { kind: 'audioTrack', id, revision: `cr_${'a'.repeat(43)}`, mediaType, visibility: 'hidden', effectiveVisibility: 'hidden',
    mediaUrl: mediaPath, coverUrl: artworkPath, capabilities: { editing: true, visibility: true },
    fields: { title: 'Synthetic published catalog Video', releaseDate: null, credits: null, attributionStatus: 'unknown', discNumber: null, trackNumber: null } };
  const headers = { 'X-Finitude-Account-Viewer': viewer, 'Cache-Control': 'no-store' };
  await page.route('**/auth/browser/session', route => route.fulfill({ json: session }));
  await page.route('**/api/listener/v1/capabilities', route => route.fulfill({ json: { playlists: false } }));
  await page.route('**/api/listener/v1/personalization-capabilities', route => route.fulfill({ json: { contractVersion: 1, deterministicDiscovery: false, artistFollows: false } }));
  await page.route('**/api/admin/v1/**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === mediaPath) {
      previewRequests++; expect(url.searchParams.get('viewer')).toBe(viewer);
      return fulfillMedia(route, mediaType === 'video' ? videoBytes : audioBytes, mediaType === 'video' ? 'video/webm' : 'audio/wav');
    }
    if (url.pathname === artworkPath) return route.fulfill({ status: 404, headers });
    expect(request.headers()['x-finitude-account-viewer']).toBe(viewer);
    if (url.pathname.endsWith('/capabilities')) return route.fulfill({ json: { ...capabilities, catalog: { editing: true, visibility: true }, localMp3Conversion: { enabled: true, readSources: true, replace: true, preset: 'mp3-320', maxFiles: 100 } }, headers });
    if (url.pathname.endsWith('/cover-operations')) return route.fulfill({ json: { items: [] }, headers });
    return route.fulfill({ json: { item }, headers });
  });
  await page.goto(`/finitude/admin/catalog/audioTrack/${id}`);
  await page.getByRole('button', { name: 'Switch to Admin view', exact: true }).click();
  await expect(page.getByRole('heading', { name: item.fields.title, exact: true })).toBeVisible();
  return { requests: () => previewRequests };
}

test('published catalog Video exposes a moving picture and controls through its private media route', async ({ page }) => {
  const flow = await setup(page), video = page.locator('video[aria-label="Private video preview"]');
  await expect(video).toBeVisible(); await expect(video).toHaveAttribute('controls', ''); await expect(video).toHaveAttribute('playsinline', '');
  await expect(page.locator('audio')).toHaveCount(0); await expect(page.getByRole('link', { name: 'Convert to MP3' })).toHaveCount(0);
  await expect(video).toHaveAttribute('poster', `${artworkPath}?viewer=${viewer}`);
  await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).videoWidth)).toBeGreaterThan(0);
  await video.evaluate(async element => { const media = element as HTMLVideoElement; media.muted = true; await media.play(); });
  await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(0.1);
  expect(flow.requests()).toBeGreaterThan(0);
  const element = await video.elementHandle();
  await page.getByRole('button', { name: 'Current view: Admin', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'User', exact: true }).click();
  await expect(page.locator('video')).toHaveCount(0);
  await expect.poll(() => element!.evaluate(node => { const media = node as HTMLVideoElement; return { connected: media.isConnected, paused: media.paused, source: media.hasAttribute('src') }; })).toEqual({ connected: false, paused: true, source: false });
});

test('saved Audio keeps the existing audio preview and MP3 conversion entry', async ({ page }) => {
  await setup(page, 'audio');
  await expect(page.locator('audio[aria-label="Private audio preview"]')).toBeVisible(); await expect(page.locator('video')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Convert to MP3', exact: true })).toHaveAttribute('href', `/finitude/admin/conversions?track=${id}`);
});
