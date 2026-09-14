import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import type { RoomCommunity, RoomCommunityEvent } from '../../src/contracts/roomV1';
import type { RoomSnapshot } from '../src/api/rooms';
import { expectNoUnownedAxeViolations } from '../e2e/support/accessibility';
import { nativeSocialBrowser } from './support/nativeSocialBrowser';

const roomPanel = (page: Page) => page.getByRole('region', { name: 'Listening room', exact: true });
const activity = (page: Page) => page.getByRole('region', { name: 'Room activity', exact: true });
const eventList = (page: Page) => activity(page).getByRole('list', { name: 'Room activity', exact: true });
const announcement = (page: Page) => page.getByRole('status', { name: 'Room activity', exact: true });

/** Observe actual HTTP projections, command identities and WS snapshots without replacing their implementations. */
const observe = (page: Page) => {
  let room: RoomSnapshot | null | undefined;
  let community: RoomCommunity | undefined;
  let subscribed = 0;
  let closed = 0;
  const reads: string[] = [];
  const commands: Array<{ action: string; commandId: string; reaction?: string }> = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'GET' && path.startsWith('/api/social/')) reads.push(path);
    if (request.method() === 'POST' && path === '/api/social/v1/room-commands') {
      const { action, commandId, reaction } = request.postDataJSON();
      commands.push({ action, commandId, reaction });
    }
  });
  page.on('response', response => {
    if (response.ok() && /\/api\/social\/v1\/rooms\/[^/]+\/community$/.test(new URL(response.url()).pathname)) {
      void response.json().then((value: { community: RoomCommunity }) => {
        if (!community || value.community.epoch > community.epoch
          || (value.community.epoch === community.epoch && value.community.revision >= community.revision)) community = value.community;
      }).catch(() => undefined);
    }
  });
  page.on('websocket', socket => {
    socket.on('close', () => { closed += 1; });
    socket.on('framereceived', frame => {
      const message = JSON.parse(String(frame.payload));
      if (message.type === 'subscribed') subscribed += 1;
      if (message.type === 'subscribed' || message.type === 'snapshot') room = message.room;
    });
  });
  return { room: () => room, community: () => community, subscribed: () => subscribed, closed: () => closed, reads, commands };
};

const login = async (page: Page, username: string, baseURL: string) => {
  await page.goto(new URL('/finitude/login', baseURL).href);
  await page.getByLabel('Email or username').fill(`${username}@example.test`);
  await page.getByLabel('Password', { exact: true }).fill('Social-real-browser-2026!');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page).not.toHaveURL(/\/login(?:[?#]|$)/);
  await page.goto(new URL('/finitude/social', baseURL).href);
  await expect(roomPanel(page)).toBeVisible();
};

/** A DOM-only observer detects replayed live announcements even when their text clears before an assertion. */
const observeAnnouncements = async (page: Page) => page.addInitScript(() => {
  const notices: string[] = [];
  Object.defineProperty(window, '__roomActivityAnnouncements', { value: notices, configurable: true });
  const lifecycle = { freezes: 0, resumes: 0 };
  Object.defineProperty(window, '__roomActivityLifecycle', { value: lifecycle, configurable: true });
  document.addEventListener('freeze', () => { lifecycle.freezes += 1; });
  document.addEventListener('resume', () => { lifecycle.resumes += 1; });
  let previous = '';
  new MutationObserver(() => {
    const text = document.querySelector('[role="status"][aria-label="Room activity"]')?.textContent?.trim() ?? '';
    if (text && text !== previous) notices.push(text);
    previous = text;
  }).observe(document, { subtree: true, childList: true, characterData: true });
});
const announcements = (page: Page) => page.evaluate(() =>
  (window as unknown as { __roomActivityAnnouncements: string[] }).__roomActivityAnnouncements);

const playing = async (page: Page) => expect.poll(() => page.locator('audio, video').evaluateAll(elements =>
  elements.filter(element => {
    const media = element as HTMLMediaElement;
    return !media.paused && media.readyState >= 3 && media.currentTime > 0;
  }).length)).toBe(1);

/** Reactions must preserve the playing occurrence, including native source and pause/load events. */
const watchContinuity = async (page: Page) => page.locator('audio, video').evaluateAll(elements => {
  const media = elements.find(element => !(element as HTMLMediaElement).paused) as HTMLMediaElement;
  if (!media) throw new Error('A playing element is required for continuity evidence.');
  const evidence = { source: media.currentSrc, startedAt: media.currentTime, events: [] as string[] };
  Object.defineProperty(window, '__roomReactionContinuity', { value: evidence, configurable: true });
  for (const event of ['pause', 'loadstart', 'emptied', 'ended']) media.addEventListener(event, () => evidence.events.push(event));
});
const expectContinuity = async (page: Page) => {
  await playing(page);
  const value = await page.evaluate(() => {
    const evidence = (window as unknown as { __roomReactionContinuity: { source: string; startedAt: number; events: string[] } }).__roomReactionContinuity;
    const media = [...document.querySelectorAll('audio, video')].find(element => !(element as HTMLMediaElement).paused) as HTMLMediaElement;
    return { ...evidence, currentSource: media?.currentSrc, currentTime: media?.currentTime };
  });
  expect(value.events).toEqual([]);
  expect(value.currentSource).toBe(value.source);
  expect(value.currentTime).toBeGreaterThan(value.startedAt);
};
const playbackIdentity = (room: RoomSnapshot) => ({
  roomId: room.roomId, epoch: room.epoch, timeline: room.timeline, preparation: room.preparation,
  controlMode: room.controlMode, controlGeneration: room.controlGeneration, queueRevision: room.queueRevision, queue: room.queue
});

/** Save evidence before axe runs so a failing narrow-width gate still retains its screenshot. */
const captureResponsive = async (page: Page, focus: Locator, name: string) => {
  const original = page.viewportSize()!;
  try {
    for (const [size, viewport] of [['desktop', original], ['320', { width: 320, height: 800 }]] as const) {
      await page.setViewportSize(viewport);
      await focus.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest' }));
      await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('html, body, main, header')]
        .every(element => element.scrollWidth <= element.clientWidth + 1)),
      { message: `${name}: no horizontal overflow at ${size}` }).toBe(true);
      const path = test.info().outputPath(`${name}-${size}.png`);
      await page.screenshot({ path, fullPage: true, animations: 'disabled' });
      await test.info().attach(`${name}-${size}`, { path, contentType: 'image/png' });
      console.log(`Room activity screenshot: ${path}`);
      if (size === '320') await expectNoUnownedAxeViolations(page, `${name}-${size}`);
    }
  } finally { await page.setViewportSize(original); }
};

const eventOf = (events: RoomCommunityEvent[] | undefined, kind: RoomCommunityEvent['kind'], alias: string, reaction: string | null = null) =>
  events?.filter(event => event.kind === kind && event.actor?.alias === alias && event.reaction === reaction) ?? [];
const broadReads = (reads: string[]) => reads.filter(path =>
  /^\/api\/social\/v1\/(?:me\/profile|profiles|relationships|music-shares)(?:\/|$)/.test(path));

test('room reactions and actor notices stay local, finite and independent of shared playback', async ({ browser, baseURL }) => {
  const contexts: BrowserContext[] = [];
  const failures: Array<{ path: string; status: number }> = [];
  let host: Page | undefined;
  let guest: Page | undefined;
  let hostedBy: Page | undefined;
  let native: Awaited<ReturnType<typeof nativeSocialBrowser>> | undefined;
  try {
    for (let index = 0; index < 3; index += 1) {
      // Both the configured process and the normal observer process disable hardware audio output.
      if (index === 2) native = await nativeSocialBrowser();
      const context = index === 2 ? native!.context : await browser.newContext({ baseURL, reducedMotion: 'reduce' }); contexts.push(context);
      context.on('response', response => {
        const path = new URL(response.url()).pathname;
        if (path.startsWith('/api/social/') && response.status() >= 400) failures.push({ path, status: response.status() });
      });
    }
    host = await contexts[0].newPage(); guest = await contexts[1].newPage();
    const hostState = observe(host); const guestState = observe(guest);
    await login(host, 'invitation_host', baseURL!);
    await login(guest, 'invitation_guest', baseURL!);
    for (const title of ['First Light', 'Across the Water']) await roomPanel(host).getByRole('checkbox', { name: new RegExp(title) }).check();
    await roomPanel(host).getByRole('button', { name: 'Start a room', exact: true }).click(); hostedBy = host;
    await expect(roomPanel(host).getByRole('button', { name: 'End room', exact: true })).toBeVisible();
    await expect(activity(host)).toBeVisible();
    await expect(eventList(host).getByText('Invitation host joined the room.', { exact: true })).toHaveCount(1);
    await expect(announcement(host)).toBeEmpty();
    const friend = roomPanel(host).getByRole('listitem').filter({ has: host.getByText('Invitation guest', { exact: true }) });
    await friend.getByRole('button', { name: 'Invite', exact: true }).click();
    await roomPanel(guest).getByRole('button', { name: 'Join room', exact: true }).click();
    await expect.poll(() => guestState.room()?.members.length).toBe(2);
    await expect(eventList(host).getByText('Invitation guest joined the room.', { exact: true })).toHaveCount(1);
    await expect(announcement(host)).toHaveText('Invitation guest joined the room.');
    await expect(announcement(guest)).toBeEmpty();
    expect(guestState.room()?.controlMode).toBe('hostOnly');
    expect(guestState.room()?.self.canControl).toBe(false);

    const observer = await contexts[2].newPage(); const observerState = observe(observer);
    await observer.setViewportSize({ width: 1280, height: 720 });
    await observer.emulateMedia({ reducedMotion: 'reduce' }); await observer.bringToFront();
    await observeAnnouncements(observer);
    await login(observer, 'invitation_guest', baseURL!);
    await expect.poll(() => observerState.room()?.self.isController).toBe(false);
    await expect(eventList(observer).getByText('Invitation guest joined the room.', { exact: true })).toHaveCount(1);
    await expect(announcement(observer)).toBeEmpty();
    expect(await announcements(observer)).toEqual([]);
    for (const page of [host, guest]) {
      const listen = roomPanel(page).getByRole('button', { name: 'Listen along', exact: true });
      if (await listen.isVisible()) await listen.click();
    }
    await expect.poll(() => guestState.room()?.members.find(member => member.memberId === guestState.room()?.self.memberId)?.ready).toBe(true);
    await roomPanel(host).getByRole('button', { name: 'Play for everyone', exact: true }).click();
    await Promise.all([playing(host), playing(guest)]);
    await expect.poll(() => playbackIdentity(guestState.room()!)).toEqual(playbackIdentity(hostState.room()!));
    await Promise.all([watchContinuity(host), watchContinuity(guest)]);
    const before = playbackIdentity(hostState.room()!);
    const probes = [hostState, guestState, observerState];
    const readStarts = probes.map(probe => probe.reads.length);
    const commandStarts = probes.map(probe => probe.commands.length);
    const reactionWindowStarted = Date.now();

    await activity(guest).getByRole('button', { name: 'Send heart', exact: true }).click();
    await expect(eventList(host).getByText('Invitation guest reacted ❤️', { exact: true })).toHaveCount(1);
    await activity(observer).getByRole('button', { name: 'Send applause', exact: true }).click();
    await expect(eventList(host).getByText('Invitation guest reacted 👏', { exact: true })).toHaveCount(1);
    for (const probe of probes) {
      await expect.poll(() => eventOf(probe.community()?.events, 'reaction', 'Invitation guest', 'heart').length).toBe(1);
      await expect.poll(() => eventOf(probe.community()?.events, 'reaction', 'Invitation guest', 'clap').length).toBe(1);
      expect(playbackIdentity(probe.room()!)).toEqual(before);
    }
    const reactionIds = hostState.community()!.events.filter(event => event.kind === 'reaction').map(event => event.eventId).sort();
    for (const probe of probes) expect(probe.community()!.events.filter(event => event.kind === 'reaction').map(event => event.eventId).sort()).toEqual(reactionIds);
    expect(new Set(reactionIds).size).toBe(2);
    await Promise.all([expectContinuity(host), expectContinuity(guest)]);
    // Drain trailing community work before native viewport/focus changes can legitimately refresh other queries.
    await new Promise(resolve => setTimeout(resolve, 1250));
    expect(probes.flatMap((probe, index) => probe.commands.slice(commandStarts[index]).map(command => command.action)).sort()).toEqual(['react', 'react']);
    expect(probes.flatMap((probe, index) => broadReads(probe.reads.slice(readStarts[index])))).toEqual([]);
    expect(observerState.room()?.self.isController).toBe(false);
    await expect(roomPanel(observer).getByRole('button', { name: 'Use this device', exact: true })).toBeVisible();
    // Global invitations have an independent 15-second fallback; reactions must not add repeated refreshes to it.
    for (const [index, probe] of probes.entries()) expect(probe.reads.slice(readStarts[index])
      .filter(path => path === '/api/social/v1/room-invitations').length)
      .toBeLessThanOrEqual(Math.floor((Date.now() - reactionWindowStarted) / 15_000) + 1);
    await captureResponsive(observer, activity(observer), 'room-activity-observer');

    await roomPanel(host).getByRole('button', { name: 'Next', exact: true }).click();
    for (const page of [host, guest, observer]) await expect(eventList(page).getByText('Invitation host changed the song.', { exact: true })).toHaveCount(1);
    await expect.poll(() => hostState.room()?.timeline?.entryId).not.toBe(before.timeline!.entryId);
    await expect.poll(() => guestState.room()?.timeline).toEqual(hostState.room()!.timeline);
    await Promise.all([playing(host), playing(guest)]);
    expect(probes.flatMap(probe => probe.commands).filter(command => command.action === 'next')).toHaveLength(1);
    for (const probe of probes) await expect.poll(() => eventOf(probe.community()?.events, 'trackChanged', 'Invitation host').length).toBe(1);
    await captureResponsive(host, activity(host), 'room-activity-notices');

    const beforeReloadSubscriptions = observerState.subscribed();
    await observer.reload();
    await expect.poll(observerState.subscribed).toBeGreaterThan(beforeReloadSubscriptions);
    await expect(activity(observer).getByRole('button', { name: 'Send heart', exact: true })).toBeEnabled();
    await expect(eventList(observer).getByText('Invitation host changed the song.', { exact: true })).toHaveCount(1);
    await expect(announcement(observer)).toBeEmpty();
    expect(await announcements(observer)).toEqual([]);
    const subscriptions = observerState.subscribed(); const closes = observerState.closed();
    const cover = await contexts[2].newPage(); await cover.goto('about:blank'); await cover.bringToFront();
    await expect.poll(() => observer.evaluate(() => document.visibilityState)).toBe('hidden');
    const lifecycle = await contexts[2].newCDPSession(observer);
    try {
      await lifecycle.send('Page.setWebLifecycleState', { state: 'frozen' });
      // The frozen renderer defers its own close callback; inspect native events after actual browser thaw.
      await new Promise(resolve => setTimeout(resolve, 200));
    } finally {
      await lifecycle.send('Page.setWebLifecycleState', { state: 'active' });
      await observer.bringToFront(); await cover.close(); await lifecycle.detach();
    }
    await expect.poll(() => observer.evaluate(() =>
      (window as unknown as { __roomActivityLifecycle: { freezes: number; resumes: number } }).__roomActivityLifecycle))
      .toEqual({ freezes: 1, resumes: 1 });
    await expect.poll(observerState.closed).toBeGreaterThan(closes);
    await expect.poll(observerState.subscribed).toBeGreaterThan(subscriptions);
    await expect(eventList(observer).getByText('Invitation host changed the song.', { exact: true })).toHaveCount(1);
    await expect(announcement(observer)).toBeEmpty();
    expect(await announcements(observer)).toEqual([]);
    expect(observerState.room()?.self.isController).toBe(false);
    await Promise.all([playing(host), playing(guest)]);

    // Real elapsed time verifies client expiry and a subsequent authorized read verifies logical server expiry.
    await expect.poll(() => eventList(host!).getByRole('listitem').count(), { timeout: 35_000, intervals: [250] }).toBe(0);
    await observer.reload();
    await expect(activity(observer)).toBeVisible();
    await expect.poll(() => observerState.community()?.events).toEqual([]);
    await expect(announcement(observer)).toBeEmpty();
    expect(await announcements(observer)).toEqual([]);

    await activity(host).getByRole('button', { name: 'Send fire', exact: true }).click();
    await expect(eventList(guest).getByText('Invitation host reacted 🔥', { exact: true })).toHaveCount(1);
    await roomPanel(host).getByRole('button', { name: 'Transfer and leave', exact: true }).click();
    await roomPanel(guest).getByRole('button', { name: 'Accept host role', exact: true }).click(); hostedBy = guest;
    await expect.poll(hostState.room).toBeNull();
    for (const page of [guest, observer]) {
      await expect(eventList(page).getByText('Invitation guest became the host.', { exact: true })).toHaveCount(1);
      await expect(eventList(page).getByText(/Invitation host/)).toHaveCount(0);
    }
    for (const probe of [guestState, observerState]) await expect.poll(() =>
      probe.community()?.events.some(event => event.actor?.alias === 'Invitation host')).toBe(false);
    await expect(activity(host)).toHaveCount(0);
    guest.once('dialog', dialog => dialog.accept());
    await roomPanel(guest).getByRole('button', { name: 'End room', exact: true }).click(); hostedBy = undefined;
    for (const probe of probes) await expect.poll(probe.room).toBeNull();
    for (const page of [host, guest, observer]) await expect(activity(page)).toHaveCount(0);
    expect(failures).toEqual([]);
  } finally {
    if (failures.length) console.log(`Room activity HTTP failures: ${JSON.stringify(failures)}`);
    try {
      if (hostedBy && !hostedBy.isClosed()) {
        const end = roomPanel(hostedBy).getByRole('button', { name: 'End room', exact: true });
        if (await end.isVisible()) {
          hostedBy.once('dialog', dialog => dialog.accept());
          await end.click(); await expect(end).toHaveCount(0);
        }
      }
    } finally {
      try { await Promise.all(contexts.filter(context => context !== native?.context).map(context => context.close())); }
      finally { await native?.close(); }
    }
  }
});
