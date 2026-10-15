import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFileSync } from 'node:fs';
import { capabilities, session, viewer } from '../src/features/admin/adminFixtures.testSupport';

/** An original synthetic tone fixture exercises the full decoder without music rights or external services. */
function wave(seconds = 2) {
  const sampleRate = 48000, samples = sampleRate * seconds, bytes = samples * 2;
  const buffer = Buffer.alloc(44 + bytes);
  buffer.write('RIFF'); buffer.writeUInt32LE(36 + bytes, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(bytes, 40);
  for (let index = 0; index < samples; index++) buffer.writeInt16LE(Math.round(Math.sin(index * 440 * Math.PI * 2 / sampleRate) * 4000), 44 + index * 2);
  return buffer;
}
const headers = { 'X-Finitude-Account-Viewer': viewer, 'Cache-Control': 'no-store' };
const trackId = '111111111111111111111111';
async function setup(page: Page, handler?: (path: string, route: import('@playwright/test').Route) => Promise<void>) {
  await page.route('**/auth/browser/session', route => route.fulfill({ json: session }));
  await page.route('**/api/listener/v1/capabilities', route => route.fulfill({ json: { playlists: false } }));
  await page.route('**/api/listener/v1/personalization-capabilities', route => route.fulfill({ json: { contractVersion: 1, deterministicDiscovery: false, artistFollows: false } }));
  await page.route('**/api/admin/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('capabilities')) return route.fulfill({ json: { ...capabilities,
      localMp3Conversion: { enabled: true, readSources: true, replace: true, preset: 'mp3-320', maxFiles: 100 } }, headers });
    if (handler) return handler(path, route);
    return route.fulfill({ status: 503, json: { code: 'synthetic_unavailable' }, headers });
  });
}
async function open(page: Page, suffix = '') {
  await page.goto(`/finitude/admin/conversions${suffix}`);
  await page.getByRole('button', { name: 'Switch to Admin view' }).click();
  await expect(page.getByRole('heading', { name: 'Local MP3 conversion' })).toBeVisible();
}
async function select(page: Page, files: { name: string; mimeType: string; buffer: Buffer }[]) {
  await page.locator('input[type=file][accept]').setInputFiles(files);
  await page.getByRole('button', { name: 'Create local conversion task' }).click();
}

/** Native storage availability varies between WebKit ports; the UI must enforce that same admission boundary. */
async function expectStorageAvailability(page: Page) {
  const capabilities = await page.evaluate(() => ({ secure: isSecureContext, indexedDB: typeof indexedDB,
    storage: typeof navigator.storage, getDirectory: typeof navigator.storage?.getDirectory,
    locksRequest: typeof navigator.locks?.request, worker: typeof Worker }));
  await test.info().attach('conversion-storage-capabilities', { contentType: 'application/json', body: JSON.stringify(capabilities) });
  const supported = capabilities.secure && capabilities.indexedDB === 'object' && capabilities.getDirectory === 'function'
    && capabilities.locksRequest === 'function' && capabilities.worker === 'function';
  if (['chromium', 'firefox'].includes(test.info().project.name)) {
    expect(supported, 'Chromium and Firefox must keep running the complete real conversion scenarios.').toBe(true);
  }
  const picker = page.getByRole('button', { name: 'Choose FLAC / WAV', exact: true });
  const folder = page.getByRole('button', { name: 'Choose an Album folder', exact: true });
  if (supported) { await expect(picker).toBeEnabled(); await expect(folder).toBeEnabled(); }
  else {
    await expect(page.getByRole('status').filter({ hasText: 'Local conversion is unavailable in this browser' })).toBeVisible();
    await expect(picker).toBeDisabled(); await expect(folder).toBeDisabled();
    await expect(page.getByRole('alert')).toHaveCount(0);
  }
  return supported;
}

/** Real encoding needs OPFS; unsupported ports still run the separate availability and source-layout scenarios. */
async function requireConversionStorage(page: Page) {
  test.skip(!await expectStorageAvailability(page), 'This browser port lacks the native durable storage required for local conversion.');
}

test('native storage availability controls capture without starting work on unsupported browsers', async ({ page }) => {
  const mutations: string[] = [];
  page.on('request', request => { if (request.method() !== 'GET' && new URL(request.url()).pathname.startsWith('/api/admin/v1/')) mutations.push(request.method()); });
  await setup(page); await open(page);
  if (!await expectStorageAvailability(page)) {
    await page.locator('input[type=file][accept]').setInputFiles([{ name: 'Tone.wav', mimeType: 'audio/wav', buffer: wave() }]);
    await expect(page.getByRole('button', { name: 'Create local conversion task' })).toBeDisabled();
    await page.locator('input[type=file][accept]').evaluate(input => (input as HTMLInputElement).form!.requestSubmit());
    await expect(page.getByRole('button', { name: 'Convert / resume Album' })).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
  }
  expect(mutations).toEqual([]);
});

test('FLAC and WAV batch converts with production CSP, retains sources and reuses completed output after reload', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await setup(page); await open(page);
  await requireConversionStorage(page);
  const flac = readFileSync(new URL('./fixtures/conversion/synthetic-mono-48.flac', import.meta.url));
  await select(page, [{ name: '01-Tone.wav', mimeType: 'untrusted/type', buffer: wave() }, { name: '02-Tone.flac', mimeType: 'audio/flac', buffer: flac }]);
  await page.getByRole('button', { name: 'Convert / resume Album' }).click();
  await expect(page.getByText('MP3 ready locally', { exact: true })).toHaveCount(2);
  await expect(page.getByText('Lossless source retained on this device', { exact: true })).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Download MP3', exact: true })).toHaveCount(2);
  await page.reload(); await page.getByRole('button', { name: 'Switch to Admin view' }).click();
  await expect(page.getByText('MP3 ready locally', { exact: true })).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Convert / resume Album' })).toBeDisabled();
  expect(errors).toEqual([]);
  const scan = await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze(); expect(scan.violations).toEqual([]);
  await page.screenshot({ path: info.outputPath('conversion-desktop.png'), fullPage: true });
  await page.getByText('MP3 ready locally', { exact: true }).last().scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('conversion-tasks-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('heading', { name: 'Local MP3 conversion' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('conversion-mobile.png'), fullPage: true });
  await page.getByText('MP3 ready locally', { exact: true }).last().scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('conversion-tasks-mobile.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('a corrupt member stays visible while the other Album member completes', async ({ page }) => {
  await setup(page); await open(page);
  await requireConversionStorage(page);
  await select(page, [{ name: 'Bad.flac', mimeType: 'audio/flac', buffer: Buffer.from('fLaC broken') }, { name: 'Good.wav', mimeType: 'audio/wav', buffer: wave() }]);
  await page.getByRole('button', { name: 'Convert / resume Album' }).click();
  await expect(page.getByText('MP3 ready locally', { exact: true })).toHaveCount(1);
  await expect(page.getByText('Needs attention; files retained', { exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Create import draft from MP3s' })).toBeDisabled();
});

test('extensionless FLAC and renamed WAV decode and download with consistent MP3 filenames', async ({ page }) => {
  await setup(page); await open(page);
  await requireConversionStorage(page);
  const flac = readFileSync(new URL('./fixtures/conversion/synthetic-mono-48.flac', import.meta.url));
  await select(page, [{ name: 'Tone', mimeType: 'application/octet-stream', buffer: flac }, { name: 'Other.data', mimeType: 'untrusted/type', buffer: wave() }]);
  await page.getByRole('button', { name: 'Convert / resume Album' }).click();
  await expect(page.getByText('MP3 ready locally', { exact: true })).toHaveCount(2);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download MP3', exact: true }).first().click();
  expect((await download).suggestedFilename()).toBe('Tone.mp3');
  await expect(page.getByRole('button', { name: 'Create import draft from MP3s' })).toBeEnabled();
});

test('an empty existing Album displays a clear explanation without a schema error', async ({ page }) => {
  await setup(page, async (_path, route) => route.fulfill({ json: { schemaVersion: 1,
    album: { id: '222222222222222222222222', title: 'Empty synthetic Album', revision: `cr_${'a'.repeat(43)}`, membershipRevision: `cm_${'a'.repeat(43)}` },
    tracks: [] }, headers }));
  await open(page, '?album=222222222222222222222222');
  await expect(page.getByText('No playable MediaTracks are linked yet.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create local conversion task' })).toBeDisabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

for (const locale of ['en-US', 'zh-Hans']) for (const width of [1280, 390]) test(`100-track Album capture keeps its action visible at ${width}px ${locale}`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 844 });
  await setup(page, async (_path, route) => route.fulfill({ json: { schemaVersion: 1,
    album: { id: '222222222222222222222222', title: 'A full Album with 100 synthetic tracks', revision: `cr_${'a'.repeat(43)}`, membershipRevision: `cm_${'a'.repeat(43)}` },
    tracks: Array.from({ length: 100 }, (_, index) => { const id = (index + 1).toString(16).padStart(24, '0'); return { id,
      albumId: '222222222222222222222222', revision: `cr_${'a'.repeat(43)}`, sourceRevision: `mr_${'b'.repeat(32)}`,
      title: `Track ${index + 1} · Long filename and Japanese 日本語 / 中文`, originalFileName: `Track-${index + 1}.wav`,
      format: { container: 'WAVE', codec: 'PCM', lossless: true, sampleRate: 48000, channels: 2, bitDepth: 24, duration: 180 },
      mediaUrl: `/api/admin/v1/catalog/audioTrack/${id}/media` }; }) }, headers }));
  await open(page, '?album=222222222222222222222222');
  const supported = await expectStorageAvailability(page);
  if (locale === 'zh-Hans') {
    await page.getByRole('button', { name: 'Change language. Current language: English (United States)' }).click();
    await page.getByRole('dialog', { name: 'Choose your language' }).getByRole('radio', { name: '简体中文', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hans');
  }
  const action = page.getByRole('button', { name: locale === 'zh-Hans' ? '创建本地转换任务' : 'Create local conversion task' });
  if (supported) await expect(action).toBeEnabled();
  else await expect(action).toBeDisabled();
  expect((await action.boundingBox())!.y).toBeLessThan(844);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByText('Track 100 · Long filename and Japanese 日本語 / 中文')).not.toBeVisible();
  await page.screenshot({ path: info.outputPath(`conversion-capture-${width}-${locale}.png`), fullPage: true });
});

test('lost upload response reconciles the same operation and deletes only the confirmed local MP3', async ({ page }) => {
  const source = wave(), etag = '"synthetic-source-v1"';
  let intent: Record<string, any> | undefined, uploadCount = 0, reads = 0;
  await setup(page, async (path, route) => {
    const method = route.request().method();
    if (path.endsWith('/source')) return route.fulfill({ json: { schemaVersion: 1, album: null, tracks: [{ id: trackId, albumId: null,
      revision: `cr_${'a'.repeat(43)}`, sourceRevision: `mr_${'b'.repeat(32)}`, title: 'Existing synthetic WAV', originalFileName: 'existing.wav',
      format: { container: 'WAVE', codec: 'PCM', lossless: true, sampleRate: 48000, channels: 1, bitDepth: 16, duration: 2 },
      mediaUrl: `/api/admin/v1/catalog/audioTrack/${trackId}/media` }] }, headers });
    if (path.endsWith('/media')) {
      if (method === 'HEAD') return route.fulfill({ status: 200, headers: { ...headers, 'Content-Type': 'audio/wav', 'Content-Length': String(source.length), ETag: etag, 'Accept-Ranges': 'bytes' } });
      const range = /^bytes=(\d+)-(\d+)$/.exec(route.request().headers().range ?? '')!;
      const start = Number(range[1]), end = Number(range[2]);
      return route.fulfill({ status: 206, headers: { ...headers, 'Content-Type': 'audio/wav', 'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${source.length}`, ETag: etag, 'Accept-Ranges': 'bytes' }, body: source.subarray(start, end + 1) });
    }
    if (path.endsWith('/operations') && method === 'POST') intent = route.request().postDataJSON();
    if (path.endsWith('/upload')) { uploadCount++; return route.abort('failed'); }
    if (!intent) return route.fulfill({ status: 404, json: { code: 'ADMIN_CONVERSION_NOT_FOUND' }, headers });
    const ready = !path.endsWith('/operations'); if (ready) reads++;
    return route.fulfill({ json: { schemaVersion: 1, operation: { operationId: intent.operationId, trackId, status: ready ? 'complete' : 'awaitingUpload',
      upload: ready ? 'ready' : 'notStarted', publication: ready ? 'ready' : 'notStarted', ready, cleanupPending: false, issue: null,
      output: { sha256: intent.output.sha256, byteLength: intent.output.byteLength, preset: 'mp3-320' } } }, headers });
  });
  await open(page, `?track=${trackId}`); await requireConversionStorage(page);
  await page.getByRole('button', { name: 'Create local conversion task' }).click();
  await page.getByRole('button', { name: 'Convert / resume Album' }).click(); await expect(page.getByText('MP3 ready locally', { exact: true })).toBeVisible();
  const submit = async () => { await page.getByRole('button', { name: 'Review MP3 replacement' }).click(); await page.getByRole('dialog').getByRole('button', { name: 'Upload / reconcile MP3s' }).click(); };
  await submit(); await expect(page.getByText('Needs attention; files retained', { exact: true })).toBeVisible();
  await page.reload(); await page.getByRole('button', { name: 'Switch to Admin view' }).click(); await submit();
  await expect(page.getByText('MP3 confirmed online; local MP3 cache removed', { exact: true })).toBeVisible();
  await expect(page.getByText('Lossless source retained on this device', { exact: true })).toBeVisible();
  expect(uploadCount).toBe(1); expect(reads).toBeGreaterThan(0);
});
