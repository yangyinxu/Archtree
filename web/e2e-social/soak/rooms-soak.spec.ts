import { expect, test, type BrowserContext, type Page, type Response } from '@playwright/test';
import type { RoomSnapshot } from '../../src/api/rooms';
import { createRoomSoakCommandDiagnostic, createRoomSoakSummary, readRoomSoakOptions, roomSoakAdmissionReason, roomSoakElapsedSeconds,
  roomSoakWindowAdmissionAt, ROOM_SOAK_MAX_DEVICE_RECOVERIES } from '../support/roomSoakPolicy';

const options = readRoomSoakOptions();
const names = ['listener_one', 'listener_two', 'listener_three', 'listener_four', 'listener_five', 'listener_six', 'listener_seven', 'listener_eight'];
const panel = (page: Page) => page.getByRole('region', { name: 'Listening room' });
const media = (page: Page) => page.locator('video').evaluateAll((nodes: HTMLVideoElement[]) =>
  nodes.map(node => ({ paused: node.paused, seeking: node.seeking, currentTime: node.currentTime,
    readyState: node.readyState, playbackRate: node.playbackRate, observedAtMs: Date.now() })));
const httpFailureStatuses = new Set([400, 401, 403, 404, 408, 409, 410, 413, 415, 422, 429, 500, 502, 503, 504]);
const httpMethods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
/** Classifies requests without retaining a URL, identity, or content-specific path. */
const httpArea = (path: string) => path === '/api/social/v1/room-commands' ? 'room-command'
  : /^\/api\/social\/v1\/(rooms(?:\/|$)|room-invitations(?:\/|$)|room-media(?:\/|$)|realtime-tickets$|capabilities$)/.test(path) ? 'room'
    : path.startsWith('/content/') ? 'media' : path.startsWith('/api/social/') ? 'social' : 'other';

/** Retains one authorized snapshot and bounded counters, never a long private frame history. */
const observe = (page: Page) => {
  let room: RoomSnapshot | null | undefined;
  let commands = 0;
  let pageErrors = 0;
  const commandDiagnostic = createRoomSoakCommandDiagnostic();
  let admissionAtMs = 0;
  const httpRequests: Record<string, number> = {};
  const httpFailures: Record<string, number> = {};
  const http429RateHeaders = { social: 0, room: 0, other: 0, 'no-header': 0 };
  const http429Reasons = { concurrency: 0, 'request-window': 0, 'media-concurrency': 0, other: 0 };
  page.on('pageerror', () => { pageErrors++; });
  page.on('request', request => {
    const area = httpArea(new URL(request.url()).pathname);
    const method = httpMethods.has(request.method()) ? request.method() : 'other';
    const key = `${area}:${method}`;
    httpRequests[key] = (httpRequests[key] ?? 0) + 1;
    if (request.method() === 'POST' && area === 'room-command') commands++;
  });
  page.on('response', async response => {
    admissionAtMs = Math.max(admissionAtMs, roomSoakWindowAdmissionAt(response.headers(), Date.now(), options.members));
    if (response.status() < 400) return;
    const area = httpArea(new URL(response.url()).pathname);
    // Closed status buckets keep successful-run evidence bounded even for unexpected responses.
    const status = response.status();
    const bucket = httpFailureStatuses.has(status) ? String(status)
      : status < 500 ? 'other4xx' : status < 600 ? 'other5xx' : 'other';
    const key = `${area}:${bucket}`;
    httpFailures[key] = (httpFailures[key] ?? 0) + 1;
    if (status === 429) {
      const limit = response.headers()['ratelimit-limit'];
      // Rate headers are inherited by later service/concurrency errors; they do not identify the rejecting limiter.
      const budget = Number(limit) === 120 ? 'social' : Number(limit) === 180 ? 'room'
        : limit === undefined ? 'no-header' : 'other';
      http429RateHeaders[budget]++;
    }
    const retryAfter = Number(response.headers()['retry-after']);
    if (response.status() === 429 && Number.isSafeInteger(retryAfter) && retryAfter > 0 && retryAfter <= 60) {
      admissionAtMs = Math.max(admissionAtMs, Date.now() + retryAfter * 1000);
    }
    if (status === 429) {
      const body = await response.json().catch(() => undefined);
      http429Reasons[roomSoakAdmissionReason(body)]++;
    }
  });
  const recordCommand = async (response: Response) => {
    if (new URL(response.url()).pathname !== '/api/social/v1/room-commands') return;
    await commandDiagnostic.record(response.status(), () => response.json());
  };
  page.on('response', recordCommand);
  page.on('websocket', socket => socket.on('framereceived', frame => {
    const message = JSON.parse(String(frame.payload));
    if (message.type === 'snapshot' || message.type === 'subscribed') room = message.room;
  }));
  return { room: () => room, commands: () => commands, pageErrors: () => pageErrors,
    httpRequests: () => ({ ...httpRequests }), httpFailures: () => ({ ...httpFailures }),
    http429RateHeaders: () => ({ ...http429RateHeaders }),
    http429Reasons: () => ({ ...http429Reasons }),
    lastCommand: commandDiagnostic.snapshot, admissionAtMs: () => admissionAtMs, recordCommand };
};

const login = async (page: Page, name: string, baseURL: string) => {
  await page.goto(new URL('/finitude/login', baseURL).href);
  await page.getByLabel('Email or username').fill(`${name}@example.test`);
  await page.getByLabel('Password', { exact: true }).fill('Social-real-browser-2026!');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page).not.toHaveURL(/\/login(?:[?#]|$)/);
  await page.goto(new URL('/finitude/social', baseURL).href);
  await expect(panel(page)).toBeVisible();
};

const advancing = async (page: Page) => {
  let first: Awaited<ReturnType<typeof media>>[number] | undefined;
  await expect.poll(async () => {
    const value = await media(page);
    const current = value[0];
    if (value.length !== 1 || current.paused || current.seeking || current.readyState < 2) { first = undefined; return false; }
    first ??= current;
    const elapsed = current.observedAtMs - first.observedAtMs;
    const advanced = (current.currentTime - first.currentTime) * 1000;
    if (advanced < 0 || Math.abs(advanced - elapsed * current.playbackRate) > 250) { first = current; return false; }
    return elapsed >= 1000 && advanced > 500;
  }).toBe(true);
};

/** Real browser/media/DB/WS endurance stays separate from short CI scenarios and never targets production. */
test('room playback repeatedly recovers and releases owned transports after sustained use', async ({ browser, request, baseURL }, testInfo) => {
  const contexts: BrowserContext[] = [];
  const summary = createRoomSoakSummary();
  let cycles = 0;
  let recoveryChecks = 0;
  let fallbackChecks = 0;
  let playbackFailure: unknown;
  let cleanupFailure: unknown;
  let cleanupComplete = false;
  let phase = 'setup';
  let timedStartedAtMs: number | null = null;
  let elapsedSeconds: number | null = null;
  let diagnostic: unknown;
  let pages: Page[] = [];
  let observations: ReturnType<typeof observe>[] = [];
  let cleanup: { activeUpgradeTransports: number; activeStreams: number; queuedPlaybackRequests: number } | undefined;
  const resources = async () => {
    const response = await request.get('/__fixture/room-soak-resources');
    expect(response.ok()).toBe(true);
    return response.json() as Promise<{ rssBytes: number; heapUsedBytes: number; activeUpgradeTransports: number;
      activeStreams: number; queuedPlaybackRequests: number; activeTcpTransports: number; retainedStorageRequests: number }>;
  };
  try {
    for (let index = 0; index < options.members; index++) contexts.push(await browser.newContext({ baseURL, reducedMotion: 'reduce' }));
    pages = await Promise.all(contexts.map(context => context.newPage()));
    observations = pages.map(observe);
    const awaitAdmission = async () => {
      // Successful responses can exhaust shared-IP headroom before any rejection; recheck hints received while waiting.
      for (;;) {
        const delay = Math.max(0, ...observations.map(value => value.admissionAtMs())) - Date.now();
        if (delay <= 0) return;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    };
    // Sequential login respects the actual same-source authentication admission limit.
    for (const [index, page] of pages.entries()) await login(page, names[index], baseURL!);
    const host = pages[0]; const guest = pages[1]; const hostPanel = panel(host);
    // Every command is one explicit gesture; observed admission hints delay it without replaying rejected intent.
    const hostCommand = async (action: 'select' | 'pause' | 'play' | 'end', gesture: () => Promise<unknown>) => {
      await awaitAdmission();
      const beforeCommands = observations[0].commands();
      const [response] = await Promise.all([
        host.waitForResponse(value => value.request().method() === 'POST'
          && new URL(value.url()).pathname === '/api/social/v1/room-commands'
          && value.request().postDataJSON()?.action === action),
        gesture()
      ]);
      // Finish diagnostics before a denied-status assertion throws; this never sends or replays a request.
      await observations[0].recordCommand(response);
      expect(response.status()).toBe(200);
      expect((await response.json()).outcome).toBe('applied');
      expect(observations[0].commands()).toBe(beforeCommands + 1);
    };
    for (const title of ['First Light', 'Across the Water', 'Home Again']) {
      await hostPanel.getByRole('checkbox', { name: new RegExp(title) }).check();
    }
    await hostPanel.getByRole('button', { name: 'Start a room', exact: true }).click();
    for (const [index, page] of pages.entries()) {
      if (index === 0) continue;
      await awaitAdmission();
      await hostPanel.getByRole('listitem').filter({ has: host.getByText(`Soak Listener ${index + 1}`, { exact: true }) })
        .getByRole('button', { name: 'Invite', exact: true }).click();
      await awaitAdmission();
      await panel(page).getByRole('button', { name: 'Join room', exact: true }).click();
    }
    await expect.poll(() => observations[0].room()?.members.length).toBe(options.members);
    for (const page of pages) {
      const listen = panel(page).getByRole('button', { name: 'Listen along', exact: true });
      if (await listen.isVisible()) await listen.click();
    }
    // Cold browser setup is not timed playback preparation: wait for every admitted device's genuine readiness first.
    await expect.poll(() => observations[0].room()?.members.filter(member => member.ready).length).toBe(options.members);
    await awaitAdmission();
    if (observations[0].room()?.timeline?.state !== 'playing') {
      await hostCommand('play', () => hostPanel.getByRole('button', { name: 'Play for everyone', exact: true }).click());
    }
    await expect.poll(() => observations[0].room()?.timeline?.state).toBe('playing');
    phase = 'initial-advancement';
    await Promise.all(pages.map(advancing));
    // Even the shortest supported duration must prove explicit recovery at least once.
    const initialCommands = observations[1].commands();
    phase = 'initial-recovery';
    await awaitAdmission();
    await guest.reload();
    const recover = panel(guest).getByRole('button', { name: 'Use this device', exact: true });
    await expect(recover).toBeEnabled();
    expect((await media(guest)).every(value => value.paused)).toBe(true);
    expect(observations[1].commands()).toBe(initialCommands);
    await awaitAdmission();
    await recover.click();
    await advancing(guest);
    expect(observations[1].commands()).toBe(initialCommands + 1);
    recoveryChecks++;
    phase = 'sustained-playback';
    const started = timedStartedAtMs = performance.now();
    let nextCycle = started;
    let nextProgress = started + 60_000;
    while (performance.now() - started < options.durationSeconds * 1000) {
      if (performance.now() >= nextCycle) {
        const beforeCommands = observations[1].commands();
        const localFallback = cycles % 3 === 2 && recoveryChecks >= ROOM_SOAK_MAX_DEVICE_RECOVERIES;
        if (cycles % 3 === 0) {
          await panel(guest).getByRole('button', { name: 'Pause only for me', exact: true }).click();
          await expect.poll(async () => (await media(guest))[0]?.paused).toBe(true);
          const room = observations[0].room()!;
          const index = room.queue.findIndex(item => item.entryId === room.timeline?.entryId);
          const chosen = room.queue[(index + 1) % room.queue.length];
          phase = 'shared-selection';
          // A rejected selection cannot pass merely because the previous track is still advancing.
          await hostCommand('select', () => hostPanel.getByRole('button', { name: `Play for everyone ${chosen.title}`, exact: true }).click());
          await expect.poll(() => observations.every(observation => {
            const timeline = observation.room()?.timeline;
            return timeline?.entryId === chosen.entryId && timeline.state === 'playing';
          })).toBe(true);
          await advancing(host);
          expect((await media(guest))[0].paused).toBe(true);
          await panel(guest).getByRole('button', { name: 'Listen along', exact: true }).click();
          expect(observations[1].commands()).toBe(beforeCommands);
        } else if (cycles % 3 === 1) {
          phase = 'shared-pause';
          await hostCommand('pause', () => hostPanel.getByRole('button', { name: 'Pause for everyone', exact: true }).click());
          await expect.poll(() => observations.every(observation => observation.room()?.timeline?.state === 'paused')).toBe(true);
          await expect.poll(async () => (await Promise.all(pages.map(media))).every(value => value.length === 1 && value[0].paused)).toBe(true);
          phase = 'shared-play';
          await hostCommand('play', () => hostPanel.getByRole('button', { name: 'Play for everyone', exact: true }).click());
          await expect.poll(() => observations.every(observation => observation.room()?.timeline?.state === 'playing')).toBe(true);
        } else if (recoveryChecks < ROOM_SOAK_MAX_DEVICE_RECOVERIES) {
          await awaitAdmission();
          await guest.reload();
          const takeControl = panel(guest).getByRole('button', { name: 'Use this device', exact: true });
          await expect(takeControl).toBeEnabled();
          expect((await media(guest)).every(value => value.paused)).toBe(true);
          expect(observations[1].commands()).toBe(beforeCommands);
          await awaitAdmission();
          await takeControl.click();
          // Use this device is itself an explicit playback/recovery gesture.
          await advancing(guest);
          expect(observations[1].commands()).toBe(beforeCommands + 1);
          recoveryChecks++;
        } else {
          // Extended runs keep exercising local intent after the bounded reload budget has been proved.
          await panel(guest).getByRole('button', { name: 'Pause only for me', exact: true }).click();
          await expect.poll(async () => (await media(guest))[0]?.paused).toBe(true);
          await panel(guest).getByRole('button', { name: 'Listen along', exact: true }).click();
          expect(observations[1].commands()).toBe(beforeCommands);
        }
        await Promise.all(pages.map(advancing));
        if (localFallback) fallbackChecks++;
        phase = 'sustained-playback';
        cycles++;
        nextCycle = performance.now() + options.cycleSeconds * 1000;
      }
      await expect.poll(() => observations.every(observation => observation.room()?.timeline?.entryId === observations[0].room()?.timeline?.entryId)).toBe(true);
      const states = await Promise.all(pages.map(media));
      expect(states.every(value => value.length === 1 && !value[0].paused)).toBe(true);
      const commonTime = Math.max(...states.map(value => value[0].observedAtMs));
      const times = states.map(value => value[0].currentTime + (commonTime - value[0].observedAtMs) / 1000 * value[0].playbackRate);
      const driftMs = (Math.max(...times) - Math.min(...times)) * 1000;
      // Reuse the existing real-browser room tolerance; this is not a newly promised product SLA.
      expect(driftMs).toBeLessThan(750);
      const sample = await resources();
      expect(sample.activeUpgradeTransports).toBeLessThanOrEqual(options.members);
      expect(sample.queuedPlaybackRequests).toBeLessThanOrEqual(32);
      expect(sample.retainedStorageRequests).toBeLessThanOrEqual(64);
      summary.record({ ...sample, driftMs });
      expect(observations.every(observation => observation.pageErrors() === 0)).toBe(true);
      if (performance.now() >= nextProgress) {
        console.log(JSON.stringify({ category: 'room_soak_progress', elapsedSeconds: Math.floor((performance.now() - started) / 1000),
          cycles, recoveryChecks, fallbackChecks, rssBytes: sample.rssBytes, heapUsedBytes: sample.heapUsedBytes,
          activeUpgradeTransports: sample.activeUpgradeTransports, driftMaxMs: summary.snapshot().driftMs.max }));
        nextProgress = performance.now() + 60_000;
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(5000, Math.max(0, options.durationSeconds * 1000 - (performance.now() - started)))));
    }
    elapsedSeconds = roomSoakElapsedSeconds(timedStartedAtMs, performance.now());
    phase = 'end-room';
    host.once('dialog', dialog => dialog.accept());
    await hostCommand('end', () => hostPanel.getByRole('button', { name: 'End room', exact: true }).click());
    await expect.poll(() => observations.every(observation => observation.room() === null)).toBe(true);
    await Promise.all(pages.map(async page => expect.poll(async () => (await media(page)).every(value => value.paused)).toBe(true)));
  } catch (error) {
    elapsedSeconds ??= roomSoakElapsedSeconds(timedStartedAtMs, performance.now());
    playbackFailure = error;
    // Fixed state fields expose readiness/admission failures without private snapshots or network identities.
    diagnostic = await Promise.all(pages.map(async (page, index) => {
      const observation = observations[index];
      const room = observation?.room();
      return { media: await media(page).catch(() => []), pageErrors: observation?.pageErrors(),
        httpRequests: observation?.httpRequests(), httpFailures: observation?.httpFailures(),
        http429RateHeaders: observation?.http429RateHeaders(), lastCommand: observation?.lastCommand(),
        http429Reasons: observation?.http429Reasons(),
        roomState: room?.timeline?.state, roomStatus: room?.status, preparationPending: Boolean(room?.preparation),
        connectedMembers: room?.members.filter(member => member.connected).length,
        readyMembers: room?.members.filter(member => member.ready).length, isController: room?.self.isController };
    }));
  } finally {
    try {
      // Attempt every context close, even if an earlier browser connection has already failed.
      const closed = await Promise.allSettled(contexts.map(context => context.close()));
      if (closed.some(result => result.status === 'rejected')) throw new Error('Owned browser context cleanup failed.');
      // Real socket and media admission counters must return to zero; memory extrema are observations, not leak verdicts.
      await expect.poll(async () => {
        cleanup = await resources();
        return cleanup.activeUpgradeTransports === 0 && cleanup.activeStreams === 0 && cleanup.queuedPlaybackRequests === 0;
      }).toBe(true);
      cleanupComplete = true;
    } catch (error) { cleanupFailure = error; }
    const evidence = { options, elapsedSeconds, cycles, recoveryChecks, fallbackChecks, cleanupComplete, phase, diagnostic,
      httpRequests: observations.map(observation => observation.httpRequests()),
      httpFailures: observations.map(observation => observation.httpFailures()),
      http429Reasons: observations.map(observation => observation.http429Reasons()),
      http429RateHeaders: observations.map(observation => observation.http429RateHeaders()), resources: summary.snapshot(), cleanup: cleanup && {
      activeUpgradeTransports: cleanup.activeUpgradeTransports, activeStreams: cleanup.activeStreams,
      queuedPlaybackRequests: cleanup.queuedPlaybackRequests } };
    await testInfo.attach('room-soak-summary', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
    console.log(JSON.stringify({ category: 'room_soak_summary', ...evidence }));
  }
  if (playbackFailure && cleanupFailure) throw new AggregateError([playbackFailure, cleanupFailure], 'Playback and owned browser cleanup failed.');
  if (playbackFailure) throw playbackFailure;
  if (cleanupFailure) throw cleanupFailure;
});
