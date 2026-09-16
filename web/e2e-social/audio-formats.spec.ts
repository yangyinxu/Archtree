import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { RoomMedia, RoomSnapshot } from '../src/api/rooms';
import { nativeSocialBrowser } from './support/nativeSocialBrowser';

const panel = (page: Page) => page.getByRole('region', { name: 'Listening room', exact: true });
const formats = [
  { title: 'MP3 Horizon', filename: 'room-tone.mp3', contentType: 'audio/mpeg' },
  { title: 'AAC Horizon', filename: 'room-tone.m4a', contentType: 'audio/mp4' },
  { title: 'VBR MP3 Horizon', filename: 'room-tone-vbr.mp3', contentType: 'audio/mpeg' }
] as const;
type Format = typeof formats[number];

/** Observe decoded browser state without substituting media events, clocks, sockets or response bytes. */
const media = (page: Page) => page.locator('audio, video').evaluateAll(elements => elements.map(element => {
  const value = element as HTMLMediaElement;
  return { source: value.currentSrc, paused: value.paused, time: value.currentTime, duration: value.duration,
    ready: value.readyState, seeking: value.seeking, error: value.error?.code ?? null, preload: value.preload,
    buffered: Array.from({ length: value.buffered.length }, (_, index) => [value.buffered.start(index), value.buffered.end(index)]),
    seekable: Array.from({ length: value.seekable.length }, (_, index) => [value.seekable.start(index), value.seekable.end(index)]) };
}));

/** Keep bounded protocol evidence and user commands; the observer never logs credentials or mutation identities. */
const observe = (page: Page) => {
  let room: RoomSnapshot | null = null;
  const commands: Array<{ action: string; positionMs?: number }> = [];
  const ready: Array<{ generation: number; revision: string }> = [];
  const streams: Array<{ path: string; revision: string | null; status: number; type: string | undefined; range: string | undefined }> = [];
  page.on('request', request => {
    if (request.method() !== 'POST' || new URL(request.url()).pathname !== '/api/social/v1/room-commands') return;
    const { action, positionMs } = request.postDataJSON();
    commands.push({ action, ...(typeof positionMs === 'number' ? { positionMs } : {}) });
  });
  page.on('response', response => {
    const url = new URL(response.url());
    if (!url.pathname.startsWith('/content/mediaTrack/stream/')) return;
    const headers = response.headers();
    streams.push({ path: url.pathname, revision: url.searchParams.get('revision'), status: response.status(),
      type: headers['content-type'], range: headers['content-range'] });
  });
  page.on('websocket', socket => {
    socket.on('framereceived', frame => {
      const value = JSON.parse(String(frame.payload));
      if (value.type === 'subscribed' || value.type === 'snapshot') room = value.room;
    });
    socket.on('framesent', frame => {
      const value = JSON.parse(String(frame.payload));
      if (value.type === 'ready' && value.report.ready) ready.push({ generation: value.report.playbackGeneration,
        revision: value.report.mediaRevision });
    });
  });
  return { room: () => room, commands, ready, streams };
};

const login = async (page: Page, username: string, baseURL: string) => {
  await page.goto(new URL('/finitude/login', baseURL).href);
  await page.getByLabel('Email or username').fill(`${username}@example.test`);
  await page.getByLabel('Password', { exact: true }).fill('Social-real-browser-2026!');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page).not.toHaveURL(/\/login/);
  await page.goto(new URL('/finitude/social', baseURL).href);
  await expect(panel(page)).toBeVisible();
};

/** Compare served byte ranges with the checked-in originals and reject a well-formed but unknown revision. */
const verifyPinnedBytes = async (request: APIRequestContext, baseURL: string, entry: RoomMedia, format: Format) => {
  const bytes = await readFile(new URL(`../../test/fixtures/room-audio/${format.filename}`, import.meta.url));
  const url = new URL(entry.streamUrl, baseURL);
  expect(url.searchParams.get('revision')).toBe(entry.mediaRevision);
  const head = await request.head(url.href);
  expect(head.status()).toBe(200);
  expect(head.headers()['content-type']).toBe(format.contentType);
  expect(Number(head.headers()['content-length'])).toBe(bytes.length);
  expect(head.headers()['accept-ranges']).toBe('bytes');
  expect(head.headers()['cache-control']).toBe('no-store, no-transform');
  const etag = head.headers().etag;
  expect(etag).toMatch(/^".+"$/);
  for (const [start, end] of [[0, 255], [Math.floor(bytes.length / 2), Math.floor(bytes.length / 2) + 255]]) {
    const response = await request.get(url.href, { headers: { Range: `bytes=${start}-${end}`, 'If-Range': etag } });
    expect(response.status()).toBe(206);
    expect(response.headers()['content-range']).toBe(`bytes ${start}-${end}/${bytes.length}`);
    expect(response.headers().etag).toBe(etag);
    expect(await response.body()).toEqual(bytes.subarray(start, end + 1));
  }
  url.searchParams.set('revision', `mr_${'0'.repeat(32)}`);
  expect(url.searchParams.get('revision')).not.toBe(entry.mediaRevision);
  for (const method of ['HEAD', 'GET']) {
    const stale = await request.fetch(url.href, { method, headers: { Range: 'bytes=0-255' } });
    expect(stale.status()).toBe(404);
    expect(stale.headers()['content-range']).toBeUndefined();
    expect(await stale.body()).toHaveLength(0);
  }
};

const expectPlaying = async (page: Page, entry: RoomMedia, baseURL: string) => {
  await expect.poll(async () => (await media(page)).filter(value => value.source === new URL(entry.streamUrl, baseURL).href
    && !value.paused && !value.seeking && value.ready >= 3 && value.error === null).length).toBe(1);
  const values = await media(page);
  expect(values).toHaveLength(1);
  expect(Math.abs(values[0].duration * 1000 - entry.durationMs)).toBeLessThan(150);
  expect(values[0].seekable.some(([start, end]) => start <= values[0].time && end >= values[0].time)).toBe(true);
};

/** Actual advancing playback over a full second exposes callback echoes as well as a one-time aligned seek. */
const expectSynchronized = async (pages: Page[], entry: RoomMedia, baseURL: string) => {
  await Promise.all(pages.map(page => expectPlaying(page, entry, baseURL)));
  const initial = await Promise.all(pages.map(page => media(page)));
  await expect.poll(async () => {
    const latest = await Promise.all(pages.map(page => media(page)));
    return latest.every((values, index) => values[0].time > initial[index][0].time + 1);
  }).toBe(true);
  const values = await Promise.all(pages.map(page => media(page)));
  const driftMs = Math.abs(values[0][0].time - values[1][0].time) * 1000;
  expect(driftMs).toBeLessThan(750);
  return { title: entry.title, driftMs, times: values.map(value => value[0].time) };
};

test('uploaded MP3 and AAC rooms prepare, seek and advance with pinned bytes and no command echo', async ({ browser, browserName, baseURL, request }) => {
  // The project chooses the host engine; a native Chromium guest also exercises synchronization across engines in Linux CI.
  const native = await nativeSocialBrowser();
  let hostContext: BrowserContext | undefined;
  try {
    hostContext = await browser.newContext({ baseURL, reducedMotion: 'reduce' });
    const host = await hostContext.newPage(), guest = await native.context.newPage();
    const hostState = observe(host), guestState = observe(guest);
    const driftEvidence: Array<Awaited<ReturnType<typeof expectSynchronized>>> = [];
    try {
      await Promise.all([login(host, 'invitation_host', baseURL!), login(guest, 'invitation_guest', baseURL!)]);
      for (const format of formats) await panel(host).getByRole('checkbox', { name: new RegExp(`^${format.title}`) }).check();
      await panel(host).getByRole('button', { name: 'Start a room', exact: true }).click();
      await expect.poll(() => hostState.room()?.queue.map(entry => entry.title)).toEqual(formats.map(format => format.title));
      const queue = hostState.room()!.queue;
      for (const [index, format] of formats.entries()) await verifyPinnedBytes(request, baseURL!, queue[index], format);
      await panel(host).getByRole('button', { name: 'Invite', exact: true }).click();
      await panel(guest).getByRole('button', { name: 'Join room', exact: true }).click();
      await expect.poll(() => guestState.room()?.members.length).toBe(2);
      await expect.poll(() => hostState.room()?.timeline?.state).toBe('paused');
      await expect.poll(() => guestState.room()?.timeline?.state).toBe('paused');
      for (const page of [host, guest]) {
        const listen = panel(page).getByRole('button', { name: 'Listen along', exact: true });
        if (await listen.isVisible()) await listen.click();
        await expect.poll(async () => (await media(page)).every(value => value.paused)).toBe(true);
      }
      const hostInitial = hostState.commands.length, guestInitial = guestState.commands.length;
      await panel(host).getByRole('button', { name: 'Play for everyone', exact: true }).click();
      driftEvidence.push(await expectSynchronized([host, guest], queue[0], baseURL!));
      expect(hostState.commands.slice(hostInitial).map(value => value.action)).toEqual(['play']);
      expect(guestState.commands).toHaveLength(guestInitial);

      for (const [index, format] of formats.entries()) {
        const entry = queue[index];
        if (index > 0) {
          const previousGeneration = hostState.room()!.timeline!.playbackGeneration;
          const beforeNext = hostState.commands.length;
          await panel(host).getByRole('button', { name: 'Next', exact: true }).click();
          await expect.poll(() => hostState.room()?.timeline?.playbackGeneration).toBe(previousGeneration + 1);
          await expect.poll(() => guestState.room()?.timeline?.entryId).toBe(entry.entryId);
          driftEvidence.push(await expectSynchronized([host, guest], entry, baseURL!));
          expect(hostState.commands.slice(beforeNext).map(value => value.action)).toEqual(['next']);
        }
        // Native pointer input captures real command preconditions and seeks well past the initial buffer position.
        const slider = panel(host).getByRole('slider');
        const bounds = await slider.boundingBox();
        expect(bounds).not.toBeNull();
        const beforeSeek = hostState.commands.length;
        const previousGeneration = hostState.room()!.timeline!.playbackGeneration;
        await slider.click({ position: { x: bounds!.width * 0.55, y: bounds!.height / 2 } });
        await expect.poll(() => hostState.commands.length).toBe(beforeSeek + 1);
        const command = hostState.commands[beforeSeek];
        expect(command.action).toBe('seek');
        expect(command.positionMs).toBeGreaterThan(50_000);
        expect(command.positionMs).toBeLessThan(80_000);
        await expect.poll(() => hostState.room()?.timeline?.playbackGeneration).toBe(previousGeneration + 1);
        await expect.poll(() => guestState.room()?.timeline?.playbackGeneration).toBe(previousGeneration + 1);
        driftEvidence.push(await expectSynchronized([host, guest], entry, baseURL!));
        for (const page of [host, guest]) expect((await media(page))[0].time).toBeGreaterThan(command.positionMs! / 1000 - 0.15);
        for (const state of [hostState, guestState]) {
          expect(state.ready).toContainEqual({ generation: previousGeneration + 1, revision: entry.mediaRevision });
          // Some engines cancel a probe or fetch the complete file; explicit API checks above still require exact byte ranges.
          const streams = state.streams.filter(value => value.path.endsWith(`/${entry.mediaTrackId}`) && value.status !== 0);
          expect(streams.length).toBeGreaterThan(0);
          expect(streams.every(value => value.revision === entry.mediaRevision && value.type === format.contentType)).toBe(true);
          expect(streams.every(value => value.status === 200 || value.status === 206 && /^bytes \d+-\d+\/\d+$/.test(value.range ?? ''))).toBe(true);
        }
        expect(hostState.commands.slice(beforeSeek).map(value => value.action)).toEqual(['seek']);
        expect(guestState.commands).toHaveLength(guestInitial);
      }
      host.once('dialog', dialog => dialog.accept());
      await panel(host).getByRole('button', { name: 'End room', exact: true }).click();
      await expect.poll(() => guestState.room()).toBeNull();
      await expect.poll(async () => (await media(guest)).every(value => value.paused)).toBe(true);
      expect(hostState.commands.slice(hostInitial).map(value => value.action)).toEqual(['play', 'seek', 'next', 'seek', 'next', 'seek', 'end']);
      expect(guestState.commands).toHaveLength(guestInitial);
    } finally {
      await test.info().attach('compressed-audio-evidence', { contentType: 'application/json', body: JSON.stringify({
        browsers: { host: browserName, guest: 'chromium' },
        drift: driftEvidence,
        host: { commands: hostState.commands, ready: hostState.ready, streams: hostState.streams, media: await media(host).catch(() => []) },
        guest: { commands: guestState.commands, ready: guestState.ready, streams: guestState.streams, media: await media(guest).catch(() => []) }
      }) });
    }
  } finally { await Promise.all([hostContext?.close(), native.close()]); }
});
