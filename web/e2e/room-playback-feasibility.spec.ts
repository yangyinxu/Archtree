import { test, expect, type Page } from '@playwright/test';
import { build } from 'vite';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { createTestTone } from './fixtures/audio';
import type {} from './support/roomPlaybackHarness';

let harnessBundle = '';
let probeServer: Server | undefined;
let probeOrigin = '';
let requestSequence = 0, caseRequestStart = 0;
let caseFormat: 'wav' | 'mp3' = 'wav';
const fixtures = {
  wav: { format: 'wav', durationSeconds: 2, sampleRate: 8_000, bytes: 0, sha256: '' },
  mp3: { format: 'mp3', durationSeconds: 120, sampleRate: 44_100, bytes: 0, sha256: '' }
};
const transport: { sequence: number; method: string; pathname: string; range: string | null; status: number;
  contentLength: number; contentRange: string | null; finished: boolean }[] = [];

/** Native Play can precede decoder progress; prove a continuous clock window before testing playback transitions. */
const expectCredibleProgress = async (page: Page) => {
  const progress = await page.evaluate(() => new Promise<{ advancedSeconds: number; elapsedSeconds: number }>((resolve, reject) => {
    const media = document.querySelector('video');
    if (!media) { reject(new Error('The room media element is missing.')); return; }
    let baseline = media.currentTime, startedAt = performance.now(), windowVersion = 0, finished = false;
    let confirmation: ReturnType<typeof setTimeout> | undefined;
    const resetWindow = () => { windowVersion += 1; baseline = media.currentTime; startedAt = performance.now(); };
    const observeSeek = (event: Event) => { if (event.isTrusted) resetWindow(); };
    const cleanup = () => {
      finished = true;
      clearTimeout(deadline);
      clearTimeout(confirmation);
      media.removeEventListener('timeupdate', observe, true);
      media.removeEventListener('seeking', observeSeek);
      media.removeEventListener('seeked', observeSeek);
      media.removeEventListener('ended', failed);
      media.removeEventListener('error', failed);
    };
    const failed = () => { cleanup(); reject(new Error('Native playback stopped before credible progress.')); };
    const deadline = setTimeout(() => {
      cleanup(); reject(new Error(`Native playback did not establish credible progress: ${JSON.stringify({
        baseline, startedAt, currentTime: media.currentTime, readyState: media.readyState,
        paused: media.paused, seeking: media.seeking, ended: media.ended, error: media.error?.code ?? null
      })}; see room-playback-evidence.json.`));
    }, 7_000);
    const observe = (event: Event) => {
      if (finished) return;
      const advancedSeconds = media.currentTime - baseline, elapsedSeconds = (performance.now() - startedAt) / 1000;
      if (!event.isTrusted) return;
      // A real startup correction may seek; only the following continuous clock window proves natural progress.
      if (media.paused || media.seeking || media.readyState < 3 || elapsedSeconds <= 0 || advancedSeconds < 0
        || advancedSeconds > elapsedSeconds * Math.max(1, media.playbackRate) + 0.05) { resetWindow(); return; }
      if (advancedSeconds <= 0.02) return;
      if (confirmation !== undefined) return;
      const sampleTime = media.currentTime, sampledAt = performance.now(), sampleWindowVersion = windowVersion;
      // The same event can trigger an authoritative correction. Confirm after all its listeners finish.
      confirmation = setTimeout(() => {
        confirmation = undefined;
        if (finished || sampleWindowVersion !== windowVersion || media.paused || media.seeking || media.readyState < 3) return;
        const subsequentAdvance = media.currentTime - sampleTime;
        if (subsequentAdvance < 0
          || subsequentAdvance > (performance.now() - sampledAt) / 1000 * Math.max(1, media.playbackRate) + 0.05) {
          resetWindow(); return;
        }
        cleanup(); resolve({ advancedSeconds, elapsedSeconds });
      }, 0);
    };
    // Read the native clock before the controller can seek while handling this same event.
    media.addEventListener('timeupdate', observe, true);
    media.addEventListener('seeking', observeSeek);
    media.addEventListener('seeked', observeSeek);
    media.addEventListener('ended', failed);
    media.addEventListener('error', failed);
    if (media.ended || media.error) failed();
  }));
  expect(progress.advancedSeconds).toBeGreaterThan(0.02);
  expect(progress.elapsedSeconds).toBeGreaterThan(0);
};

/** Uses native loopback HTTP for both the probe and media; intercepted responses are not a real decoder transport. */
const startProbeServer = async () => {
  const tone = createTestTone().subarray(0, 44 + 2 * 8000 * 2);
  tone.writeUInt32LE(tone.length - 8, 4);
  tone.writeUInt32LE(tone.length - 44, 40);
  expect((tone.length - 44) / tone.readUInt32LE(28)).toBe(fixtures.wav.durationSeconds);
  const mp3 = await readFile(new URL('../../test/fixtures/room-audio/room-tone.mp3', import.meta.url));
  for (const [format, body] of [['wav', tone], ['mp3', mp3]] as const) {
    fixtures[format].bytes = body.length;
    fixtures[format].sha256 = createHash('sha256').update(body).digest('hex');
  }
  const resources = new Map<string, { body: Buffer; type: string; etag?: string }>([
    ['/__room-probe', { body: Buffer.from('<!doctype html><html><body><script src="/__room-probe.js"></script></body></html>'), type: 'text/html; charset=utf-8' }],
    ['/__room-probe.js', { body: Buffer.from(harnessBundle), type: 'text/javascript; charset=utf-8' }],
    ['/__room-tone/a.wav', { body: tone, type: 'audio/wav', etag: '"room-tone-wav"' }],
    ['/__room-tone/b.wav', { body: tone, type: 'audio/wav', etag: '"room-tone-wav"' }],
    ['/__room-tone/a.mp3', { body: mp3, type: 'audio/mpeg', etag: '"room-tone-mp3"' }],
    ['/__room-tone/b.mp3', { body: mp3, type: 'audio/mpeg', etag: '"room-tone-mp3"' }]
  ]);
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const resource = resources.get(pathname), method = request.method ?? 'unknown';
    const rangeHeader = request.headers.range;
    const evidence = { sequence: ++requestSequence, method: ['GET', 'HEAD'].includes(method) ? method : 'unsupported',
      pathname: resources.has(pathname) ? pathname : 'unrecognized',
      range: typeof rangeHeader === 'string' && /^bytes=\d*-\d*$/.test(rangeHeader) && rangeHeader.length <= 64 ? rangeHeader : rangeHeader ? 'unsupported' : null,
      status: 0, contentLength: 0, contentRange: null as string | null, finished: false };
    transport.push(evidence);
    if (transport.length > 100) transport.shift();
    response.once('finish', () => { evidence.finished = true; });
    const send = (status: number, body: Buffer, contentRange?: string) => {
      evidence.status = status;
      evidence.contentLength = body.length;
      evidence.contentRange = contentRange ?? null;
      response.writeHead(status, { 'Content-Type': resource?.type ?? 'text/plain', 'Content-Length': body.length,
        'Cache-Control': 'no-store, no-transform', 'X-Content-Type-Options': 'nosniff',
        ...(resource?.etag ? { 'Accept-Ranges': 'bytes', ETag: resource.etag } : {}),
        ...(contentRange ? { 'Content-Range': contentRange } : {}) });
      response.end(method === 'HEAD' ? undefined : body);
    };
    if (!['GET', 'HEAD'].includes(method)) { send(405, Buffer.alloc(0)); return; }
    if (!resource) { send(404, Buffer.alloc(0)); return; }
    if (method === 'HEAD') { send(200, resource.body); return; }
    if (!rangeHeader || !resource.etag
      || (request.headers['if-range'] && request.headers['if-range'] !== resource.etag)) {
      send(200, resource.body); return;
    }
    const range = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
    const start = range?.[1] ? Number(range[1]) : Math.max(0, resource.body.length - Number(range?.[2]));
    const end = range?.[1] ? range[2] ? Number(range[2]) : resource.body.length - 1 : resource.body.length - 1;
    if (!range || (!range[1] && !range[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || start < 0 || start >= resource.body.length || end < start || (!range[1] && Number(range[2]) <= 0)) {
      send(416, Buffer.alloc(0), `bytes */${resource.body.length}`); return;
    }
    const last = Math.min(end, resource.body.length - 1);
    send(206, resource.body.subarray(start, last + 1), `bytes ${start}-${last}/${resource.body.length}`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('The loopback media server did not acquire a port.');
  probeServer = server;
  probeOrigin = `http://127.0.0.1:${address.port}`;
  for (const [format, body, contentType] of [['wav', tone, 'audio/wav'], ['mp3', mp3, 'audio/mpeg']] as const) {
    const url = `${probeOrigin}/__room-tone/a.${format}`, etag = `"room-tone-${format}"`;
    const head = await fetch(url, { method: 'HEAD', headers: { Range: 'bytes=0-1' } });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-type')).toBe(contentType);
    expect(head.headers.get('content-length')).toBe(String(body.length));
    expect(head.headers.get('accept-ranges')).toBe('bytes');
    expect(head.headers.get('etag')).toBe(etag);
    expect((await head.arrayBuffer()).byteLength).toBe(0);
    expect(Buffer.from(await (await fetch(url)).arrayBuffer()).equals(body)).toBe(true);
    const middle = Math.floor(body.length / 2);
    for (const [range, start, end] of [['bytes=0-1', 0, 1], [`bytes=${middle}-${middle + 255}`, middle, middle + 255],
      [`bytes=${middle}-`, middle, body.length - 1], ['bytes=-1', body.length - 1, body.length - 1]] as const) {
      const response = await fetch(url, { headers: { Range: range, 'If-Range': etag } });
      expect(response.status).toBe(206);
      expect(response.headers.get('content-length')).toBe(String(end - start + 1));
      expect(response.headers.get('content-range')).toBe(`bytes ${start}-${end}/${body.length}`);
      expect(response.headers.get('etag')).toBe(etag);
      expect(Buffer.from(await response.arrayBuffer()).equals(body.subarray(start, end + 1))).toBe(true);
    }
    const changed = await fetch(url, { headers: { Range: 'bytes=0-1', 'If-Range': '"unrecognized"' } });
    expect(changed.status).toBe(200);
    expect(changed.headers.get('content-length')).toBe(String(body.length));
    expect(changed.headers.get('content-range')).toBeNull();
    expect(Buffer.from(await changed.arrayBuffer()).equals(body)).toBe(true);
    const unavailable = await fetch(url, { headers: { Range: `bytes=${body.length}-` } });
    expect(unavailable.status).toBe(416);
    expect(unavailable.headers.get('content-range')).toBe(`bytes */${body.length}`);
    expect((await unavailable.arrayBuffer()).byteLength).toBe(0);
  }
};

test.beforeAll(async () => {
  const output = await build({
    configFile: false,
    publicDir: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      lib: {
        entry: fileURLToPath(new URL('./support/roomPlaybackHarness.ts', import.meta.url)),
        name: 'RoomPlaybackProbe', formats: ['iife']
      }
    }
  });
  if (!Array.isArray(output) || output[0].output[0].type !== 'chunk') {
    throw new Error('Expected an in-memory room feasibility bundle.');
  }
  harnessBundle = output[0].output[0].code;
  await startProbeServer();
});

test.beforeEach(async ({ page }, testInfo) => {
  caseRequestStart = requestSequence;
  caseFormat = testInfo.title.startsWith('real scheduled start') ? 'mp3' : 'wav';
  await page.goto(`${probeOrigin}/__room-probe${caseFormat === 'mp3' ? '?format=mp3' : ''}`);
  await page.waitForFunction(() => Boolean(window.roomProbe));
});

test.afterEach(async ({ page }, testInfo) => {
  if (page.isClosed()) return;
  const state = await page.evaluate(() => window.roomProbe?.state()).catch(() => undefined);
  if (state) {
    const path = testInfo.outputPath('room-playback-evidence.json');
    const nativeDurationSeconds = state.duration
      ?? state.mediaEvents.filter(event => event.event === 'loadedmetadata').at(-1)?.duration ?? null;
    await writeFile(path, JSON.stringify({ ...state, fixture: { ...fixtures[caseFormat], nativeDurationSeconds },
      transport: transport.filter(item => item.sequence > caseRequestStart) }, null, 2));
    await testInfo.attach('room-playback-evidence', { contentType: 'application/json', path });
  }
});

test.afterAll(async ({}, testInfo) => {
  const server = probeServer;
  if (!server) return;
  const stopped = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  server.closeAllConnections();
  await stopped;
  expect(server.listening).toBe(false);
  await testInfo.attach('room-playback-transport-lifecycle', {
    contentType: 'application/json', body: JSON.stringify({ listening: server.listening, requests: requestSequence })
  });
});

test('real audio prepares and seeks without feedback; shared trace keeps one media element', async ({ page }) => {
  await page.evaluate(() => window.roomProbe.apply(0));
  await expect.poll(() => page.evaluate(() => window.roomProbe.state().observations.some((item) => item.type === 'ready'))).toBe(true);
  await page.evaluate(() => window.roomProbe.apply(1));
  await expect.poll(() => page.evaluate(() => window.roomProbe.state().observations.some((item) => item.type === 'ready' && item.entryId === 'entry-b'))).toBe(true);
  const loaded = await page.evaluate(() => window.roomProbe.state().loads);
  expect(await page.evaluate(() => window.roomProbe.apply(2))).toBe(false);
  expect(await page.evaluate(() => window.roomProbe.apply(3))).toBe(true);
  expect(await page.evaluate(() => window.roomProbe.apply(4))).toBe(false);
  await page.evaluate(() => window.roomProbe.apply(5));
  await expect.poll(() => page.evaluate(() => window.roomProbe.state().observations.some((item) => item.type === 'actual-start'))).toBe(true);
  await page.evaluate(() => window.roomProbe.apply(6));
  await expect.poll(() => page.evaluate(() => window.roomProbe.state().observations.some((item) => item.type === 'seek-complete' && item.playbackEpoch === 44))).toBe(true);
  await expect.poll(() => page.evaluate(() => window.roomProbe.state().seeking)).toBe(false);
  const state = await page.evaluate(() => window.roomProbe.state());
  expect(state.currentTime, JSON.stringify(state)).toBeCloseTo(0.5, 1);
  expect(state.loads).toBe(loaded);
  expect(state.creations).toBe(1);
  expect(state.mediaCount).toBe(1);
  expect(state.intents).toEqual([]);
  expect(state.paused).toBe(true);
  await page.evaluate(() => window.roomProbe.destroy());
});

test('real scheduled start, local pause, rate correction and natural end cannot echo commands', async ({ page }) => {
  await page.evaluate(() => window.roomProbe.apply(0));
  await expect.poll(() => page.evaluate(() => window.roomProbe.state().readyState)).toBeGreaterThanOrEqual(3);
  await expect.poll(() => page.evaluate((durationSeconds) => {
    const state = window.roomProbe.state();
    // Match the social MP3 gate's 150 ms boundary for native gapless/frame-padding differences.
    return { finiteFixtureDuration: Number.isFinite(state.duration) && (state.duration ?? 0) > 0
      && Math.abs((state.duration ?? 0) - durationSeconds) < 0.15,
      seekable: state.seekable.length > 0 };
  }, fixtures.mp3.durationSeconds), { message: 'Native MP3 must expose its real fixture duration and seekable range before scheduling.' })
    .toEqual({ finiteFixtureDuration: true, seekable: true });
  const anchor = await page.evaluate(() => performance.now() + 350);
  await page.evaluate((anchorMonotonicMs) => window.roomProbe.apply(5, { anchorMonotonicMs }), anchor);
  expect(await page.evaluate(() => window.roomProbe.state().paused)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.roomProbe.state().observations.filter((item) => item.type === 'actual-start').length)).toBe(1);
  const actual = await page.evaluate(() => window.roomProbe.state().observations.find((item) => item.type === 'actual-start')!.monotonicMs);
  expect(actual).toBeGreaterThanOrEqual(anchor - 10);
  await expectCredibleProgress(page);
  await page.evaluate(() => window.roomProbe.pauseLocally());
  await page.evaluate(() => window.roomProbe.apply(5, { revision: 10, playbackEpoch: 50 }));
  expect(await page.evaluate(() => window.roomProbe.state().paused)).toBe(true);
  await page.evaluate(() => window.roomProbe.resync());
  await expect.poll(() => page.evaluate(() => window.roomProbe.state().paused)).toBe(false);
  await expectCredibleProgress(page);
  expect(await page.evaluate(() => window.roomProbe.correct((window.roomProbe.state().currentTime ?? 0) + 0.25))).toBe('rate');
  expect(await page.evaluate(() => window.roomProbe.state().rate)).toBe(1.05);
  await page.evaluate(() => window.roomProbe.seekThroughNativeElement(window.roomProbe.state().duration! - 0.2));
  await expect.poll(() => page.evaluate(() => window.roomProbe.state().snapshot.status)).toBe('ended');
  const ended = await page.evaluate(() => window.roomProbe.state());
  expect(ended.snapshot.currentItem?.title).toBe('b');
  expect(ended.intents).toEqual([]);
  await page.evaluate(() => window.roomProbe.next());
  const explicit = await page.evaluate(() => window.roomProbe.state());
  expect(explicit.intents).toHaveLength(1);
  expect(explicit.intents[0]).toMatchObject({ type: 'next', expectedEntryId: 'entry-b', expectedPlaybackEpoch: 50 });
  await page.evaluate(() => window.roomProbe.destroy());
});
