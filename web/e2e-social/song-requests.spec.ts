import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import type { RoomSnapshot } from '../src/api/rooms';
import { expectNoUnownedAxeViolations } from '../e2e/support/accessibility';

const roomPanel = (page: Page) => page.getByRole('region', { name: 'Listening room', exact: true });
const requests = (page: Page) => page.getByRole('region', { name: 'Song requests', exact: true });
const queue = (page: Page) => page.getByRole('region', { name: 'Room queue', exact: true });
const trackRow = (region: Locator, title: string) => region.locator(':scope > ul[aria-label="Song requests"], :scope > ol').getByRole('listitem').filter({
  has: region.page().getByText(title, { exact: true })
});

/** Reads actual server frames; no socket, command or media response is replaced. */
const observeRoom = (page: Page) => {
  let current: RoomSnapshot | null = null;
  page.on('websocket', socket => socket.on('framereceived', frame => {
    const message = JSON.parse(String(frame.payload));
    if (message.type === 'subscribed' || message.type === 'snapshot') current = message.room;
  }));
  return () => current;
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

const playing = async (page: Page) => {
  await expect.poll(() => page.locator('audio, video').evaluateAll(elements => elements.filter(element => {
    const media = element as HTMLMediaElement;
    return !media.paused && media.readyState >= 3 && media.currentTime > 0;
  }).length)).toBe(1);
};

/** Records native interruptions only during edits that must preserve the existing playback occurrence. */
const watchContinuity = async (page: Page) => page.locator('audio, video').evaluateAll(elements => {
  const media = elements.find(element => !(element as HTMLMediaElement).paused) as HTMLMediaElement;
  if (!media) throw new Error('Continuity evidence requires an actually playing element.');
  const evidence = { source: media.currentSrc, startedAt: media.currentTime, events: [] as string[] };
  Object.defineProperty(window, '__songRequestContinuity', { value: evidence, configurable: true });
  for (const event of ['pause', 'loadstart', 'emptied', 'ended']) media.addEventListener(event, () => evidence.events.push(event));
});

const expectContinuity = async (page: Page) => {
  await playing(page);
  const evidence = await page.evaluate(() => {
    const recorded = (window as unknown as { __songRequestContinuity: { source: string; startedAt: number; events: string[] } }).__songRequestContinuity;
    const media = [...document.querySelectorAll('audio, video')].find(element => !(element as HTMLMediaElement).paused) as HTMLMediaElement;
    return { ...recorded, currentSource: media?.currentSrc, currentTime: media?.currentTime };
  });
  expect(evidence.events).toEqual([]);
  expect(evidence.currentSource).toBe(evidence.source);
  expect(evidence.currentTime).toBeGreaterThan(evidence.startedAt);
};

/** Captures real moderation/attribution controls at both widths and restores the original viewport. */
const captureResponsive = async (page: Page, focus: Locator, name: string) => {
  const original = page.viewportSize()!;
  try {
    for (const [size, viewport] of [['desktop', original], ['320', { width: 320, height: 800 }]] as const) {
      await page.setViewportSize(viewport);
      await focus.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest' }));
      await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('html, body, main, header')]
        .every(element => element.scrollWidth <= element.clientWidth + 1)),
      { message: `${name}: no horizontal overflow at ${size}` }).toBe(true);
      if (size === '320') await expectNoUnownedAxeViolations(page, `${name}-${size}`);
      const path = test.info().outputPath(`${name}-${size}.png`);
      await page.screenshot({ path, fullPage: true, animations: 'disabled' });
      await test.info().attach(`${name}-${size}`, { path, contentType: 'image/png' });
      console.log(`Song request screenshot: ${path}`);
    }
  } finally { await page.setViewportSize(original); }
};

const requestSong = async (page: Page, title: string) => {
  await requests(page).getByRole('radio', { name: new RegExp(`^${title}`) }).check();
  await requests(page).getByRole('button', { name: 'Request song', exact: true }).click();
  await expect(trackRow(requests(page), title)).toBeVisible();
};

const endRoom = async (page: Page) => {
  if (page.isClosed()) return;
  const end = roomPanel(page).getByRole('button', { name: 'End room', exact: true });
  if (!await end.isVisible()) return;
  page.once('dialog', dialog => dialog.accept());
  await end.click();
  await expect(end).toHaveCount(0);
};

test('Host-control guests request songs while host moderation and queue edits preserve real playback', async ({ browser, baseURL }) => {
  // This project owns a separate server and stores; its browser inherits --disable-audio-output.
  const contexts: BrowserContext[] = [];
  const failures: Array<{ path: string; status: number }> = [];
  const actions: string[] = [];
  let host: Page | undefined;
  try {
    for (let index = 0; index < 2; index += 1) {
      const context = await browser.newContext({ baseURL, reducedMotion: 'reduce' }); contexts.push(context);
      context.on('response', response => {
        const path = new URL(response.url()).pathname;
        if (path.startsWith('/api/social/') && response.status() >= 400) failures.push({ path, status: response.status() });
      });
      context.on('request', request => {
        if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/social/v1/room-commands') actions.push(request.postDataJSON().action);
      });
    }
    host = await contexts[0].newPage(); const guest = await contexts[1].newPage();
    const hostRoom = observeRoom(host); const guestRoom = observeRoom(guest);
    await login(host, 'invitation_host', baseURL!);
    await login(guest, 'invitation_guest', baseURL!);
    await roomPanel(host).getByRole('checkbox', { name: /First Light/ }).check();
    await roomPanel(host).getByRole('button', { name: 'Start a room', exact: true }).click();
    await expect(roomPanel(host).getByRole('button', { name: 'End room', exact: true })).toBeVisible();
    const friend = roomPanel(host).getByRole('listitem').filter({ has: host.getByText('Invitation guest', { exact: true }) });
    await friend.getByRole('button', { name: 'Invite', exact: true }).click();
    await roomPanel(guest).getByRole('button', { name: 'Join room', exact: true }).click();
    await expect.poll(() => guestRoom()?.members.length).toBe(2);
    expect(guestRoom()?.controlMode).toBe('hostOnly');
    expect(guestRoom()?.self.canControl).toBe(false);
    await expect(roomPanel(guest).getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
    for (const page of [host, guest]) {
      const listen = roomPanel(page).getByRole('button', { name: 'Listen along', exact: true });
      if (await listen.isVisible()) await listen.click();
    }
    await expect.poll(() => guestRoom()?.members.find(member => member.memberId === guestRoom()?.self.memberId)?.ready).toBe(true);
    await roomPanel(host).getByRole('button', { name: 'Play for everyone', exact: true }).click();
    await Promise.all([playing(host), playing(guest)]);
    await expect.poll(() => guestRoom()?.timeline).toEqual(hostRoom()!.timeline);
    const timeline = hostRoom()!.timeline!;
    const originalEntry = timeline.entryId;
    const queueRevision = hostRoom()!.queueRevision;
    await Promise.all([watchContinuity(host), watchContinuity(guest)]);

    await requestSong(guest, 'Across the Water');
    const pending = trackRow(requests(host), 'Across the Water');
    await expect(pending.getByText('Requested by Invitation guest', { exact: true })).toBeVisible();
    await expect(trackRow(requests(guest), 'Across the Water').getByRole('button', { name: 'Withdraw request', exact: true })).toBeVisible();
    await expect(requests(guest).getByRole('button', { name: 'Add to queue', exact: true })).toHaveCount(0);
    await captureResponsive(host, pending, 'song-request-moderation');
    await pending.getByRole('button', { name: 'Add to queue', exact: true }).click();
    await expect(pending).toHaveCount(0);
    for (const page of [host, guest]) await expect(trackRow(queue(page), 'Across the Water')
      .getByText('Requested by Invitation guest', { exact: true })).toBeVisible();
    await expect.poll(() => guestRoom()?.queue.map(entry => entry.title)).toEqual(['First Light', 'Across the Water']);
    await expect.poll(() => hostRoom()?.queueRevision).toBe(queueRevision + 1);
    await captureResponsive(guest, trackRow(queue(guest), 'Across the Water'), 'song-request-attribution');
    await expect(queue(guest).getByRole('button', { name: /^Move .* (earlier|later)$/ })).toHaveCount(0);
    await expect(queue(guest).getByRole('button', { name: /^Remove .* from queue$/ })).toHaveCount(0);
    await expect(queue(host).getByRole('button', { name: 'Remove First Light from queue', exact: true })).toBeDisabled();

    await queue(host).getByRole('button', { name: 'Move Across the Water earlier', exact: true }).click();
    await expect.poll(() => guestRoom()?.queue.map(entry => entry.title)).toEqual(['Across the Water', 'First Light']);
    await expect.poll(() => hostRoom()?.queueRevision).toBe(queueRevision + 2);
    await queue(host).getByRole('button', { name: 'Remove Across the Water from queue', exact: true }).click();
    await expect.poll(() => guestRoom()?.queue.map(entry => entry.title)).toEqual(['First Light']);
    await expect.poll(() => hostRoom()?.queueRevision).toBe(queueRevision + 3);

    await requestSong(guest, 'Home Again');
    await expect(trackRow(requests(host), 'Home Again')).toBeVisible();
    await trackRow(requests(guest), 'Home Again').getByRole('button', { name: 'Withdraw request', exact: true }).click();
    await expect(trackRow(requests(host), 'Home Again')).toHaveCount(0);
    await expect(trackRow(requests(guest), 'Home Again')).toHaveCount(0);
    await requestSong(guest, 'Home Again');
    await trackRow(requests(host), 'Home Again').getByRole('button', { name: 'Dismiss', exact: true }).click();
    await expect(trackRow(requests(host), 'Home Again')).toHaveCount(0);
    await expect(trackRow(requests(guest), 'Home Again')).toHaveCount(0);
    for (const current of [hostRoom, guestRoom]) {
      expect(current()?.timeline).toEqual(timeline);
      expect(current()?.timeline?.entryId).toBe(originalEntry);
      expect(current()?.controlMode).toBe('hostOnly');
    }
    await Promise.all([expectContinuity(host), expectContinuity(guest)]);
    expect(actions.filter(action => ['play', 'pause', 'next', 'previous', 'select', 'seek', 'takeControl'].includes(action))).toEqual(['play']);
    expect(actions.filter(action => action === 'requestSong')).toHaveLength(3);
    expect(actions.filter(action => action === 'dismissSongRequest')).toHaveLength(2);
    expect(actions.filter(action => action === 'acceptSongRequest')).toHaveLength(1);
    expect(actions.filter(action => action === 'reorderQueue')).toHaveLength(1);
    expect(actions.filter(action => action === 'removeQueueEntry')).toHaveLength(1);
    await endRoom(host);
    await expect.poll(guestRoom).toBeNull();
    expect(failures).toEqual([]);
  } finally {
    if (failures.length) console.log(`Song request HTTP failures: ${JSON.stringify(failures)}`);
    try { if (host) await endRoom(host).catch(() => undefined); }
    finally { await Promise.all(contexts.map(context => context.close())); }
  }
});
