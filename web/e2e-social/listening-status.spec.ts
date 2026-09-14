import { expect, test, type BrowserContext, type Locator, type Page, type Request } from '@playwright/test';
import type { RoomSnapshot } from '../src/api/rooms';
import { expectNoUnownedAxeViolations } from '../e2e/support/accessibility';

const roomPanel = (page: Page) => page.getByRole('region', { name: 'Listening room', exact: true });
const listening = (page: Page) => page.getByRole('region', { name: 'Listening with friends', exact: true });
const sharing = (page: Page) => page.getByRole('region', { name: 'Share what I’m listening to', exact: true });
const player = (page: Page) => page.getByRole('region', { name: 'Now playing', exact: true });
const transport = (page: Page) => player(page).getByRole('group', { name: 'Playback controls', exact: true });
const statusCard = (page: Page) => listening(page).getByRole('listitem').filter({
  has: page.getByText('Invitation host is listening', { exact: true })
});

/** Captures authorized server snapshots, never replacing browser authority or playback. */
const observeRoom = (page: Page) => {
  let current: RoomSnapshot | null | undefined;
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
  await page.getByRole('link', { name: 'Together', exact: true }).click();
  await expect(sharing(page)).toBeAttached();
};

const silent = async (page: Page) => expect.poll(() => page.locator('audio, video').evaluateAll(elements =>
  elements.every(element => (element as HTMLMediaElement).paused))).toBe(true);
const playing = async (page: Page, title: string) => {
  await expect(player(page)).toContainText(title);
  await expect.poll(() => page.locator('audio, video').evaluateAll(elements => elements.filter(element => {
    const media = element as HTMLMediaElement;
    return !media.paused && media.readyState >= 3 && media.currentTime > 0;
  }).length)).toBe(1);
};

/** SPA navigation retains the one actual player and its captured source identity. */
const playCatalog = async (page: Page, title: string) => {
  await page.getByRole('link', { name: 'Search', exact: true }).click();
  const input = page.locator('#page-search');
  await input.fill(title); await input.press('Enter');
  await page.getByRole('button', { name: `Play ${title}`, exact: true }).click();
  await playing(page, title);
  await page.getByRole('link', { name: 'Together', exact: true }).click();
  await expect(sharing(page)).toBeAttached();
};

const refreshListening = async (page: Page) => {
  await listening(page).scrollIntoViewIfNeeded();
  await listening(page).getByRole('button', { name: 'Refresh listening status', exact: true }).click();
};
const expectStatus = async (page: Page, title: string) => {
  await listening(page).scrollIntoViewIfNeeded();
  await expect(statusCard(page)).toHaveCount(1);
  await expect(statusCard(page).getByText(title, { exact: true })).toBeVisible();
};

/** Screenshots precede axe so failures retain the exact real desktop and narrow layout. */
const captureResponsive = async (page: Page, focus: Locator, name: string) => {
  const original = page.viewportSize()!;
  try {
    for (const [size, viewport] of [['desktop', original], ['320', { width: 320, height: 800 }]] as const) {
      await page.setViewportSize(viewport);
      await focus.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest' }));
      const path = test.info().outputPath(`${name}-${size}.png`);
      await page.screenshot({ path, fullPage: true, animations: 'disabled' });
      await test.info().attach(`${name}-${size}`, { path, contentType: 'image/png' });
      console.log(`Listening status screenshot: ${path}`);
      await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('html, body, main, header, [role="dialog"]')]
        .every(element => element.scrollWidth <= element.clientWidth + 1)),
      { message: `${name}: no horizontal overflow at ${size}` }).toBe(true);
      if (size === '320' && name === 'friend-listening-status') {
        // No overflow alone misses an alias squeezed into a tall column of broken words.
        await expect.poll(async () => (await statusCard(page).getByText('Invitation host is listening', { exact: true }).boundingBox())?.width ?? 0,
          { message: 'The friend identity retains readable width beside or above its invitation action' }).toBeGreaterThanOrEqual(150);
      }
      if (size === '320') await expectNoUnownedAxeViolations(page, `${name}-${size}`);
    }
  } finally { await page.setViewportSize(original); }
};

const endRoom = async (page: Page) => {
  if (page.isClosed()) return;
  const end = roomPanel(page).getByRole('button', { name: 'End room', exact: true });
  if (!await end.isVisible()) return;
  page.once('dialog', dialog => dialog.accept()); await end.click();
  await expect(end).toHaveCount(0);
};

test('friends see only fresh opted-in actual audio, with device fences and explicit paused-room invitations', async ({ browser, baseURL }) => {
  // Each project owns its database/S3/rate windows. Chromium inherits --disable-audio-output.
  const contexts: BrowserContext[] = [];
  const failures: Array<{ method: string; path: string; status: number }> = [];
  const otherServerFailures: Array<{ method: string; path: string; status: number }> = [];
  const privacyErrors: string[] = [];
  const inspections: Promise<void>[] = [];
  const roomObservers = new Map<Page, ReturnType<typeof observeRoom>>();
  const admittedReads = new WeakMap<Request, string>();
  const pendingRoomReads = new Set<Request>();
  const ends: Array<{ roomId: string; startedAt: number; applied: boolean }> = [];
  const retiringReads: Array<{ failure: typeof failures[number]; roomId: string; admitted: boolean; respondedAt: number; body: unknown }> = [];
  const actions: string[] = [], saveWrites: string[] = [];
  const claims: number[] = [0, 0, 0];
  const reports: Array<{ device: number; state: string; room: boolean }> = [];
  let friend: Page | undefined;
  let created = false;
  try {
    for (let device = 0; device < 3; device += 1) {
      const context = await browser.newContext({ baseURL, reducedMotion: 'reduce' }); contexts.push(context);
      context.on('request', request => {
        const path = new URL(request.url()).pathname;
        if (request.method() === 'GET' && /^\/api\/social\/v1\/rooms\/r_[A-Za-z0-9_-]+\/community$/.test(path)) {
          pendingRoomReads.add(request);
          const room = roomObservers.get(request.frame().page())?.();
          if (room) admittedReads.set(request, room.roomId);
        }
        if (request.method() === 'POST' && path === '/api/social/v1/room-commands') actions.push(request.postDataJSON().action);
        if (request.method() === 'POST' && path === '/api/social/v1/listening-publications/claim') claims[device] += 1;
        if (request.method() === 'POST' && path === '/api/social/v1/listening-publications/report') {
          const body = request.postDataJSON();
          // Retain only aggregate observation kinds; never log scope/publication/client/session identifiers.
          reports.push({ device, state: body.state, room: Boolean(body.playback?.room) });
        }
        if (['PUT', 'DELETE'].includes(request.method()) && /^\/content\/me\/saves\//.test(path)) saveWrites.push(path);
      });
      context.on('requestfinished', request => pendingRoomReads.delete(request));
      context.on('requestfailed', request => pendingRoomReads.delete(request));
      context.on('response', response => {
        const path = new URL(response.url()).pathname;
        const request = response.request();
        if (path === '/api/social/v1/room-commands' && request.method() === 'POST' && response.ok()) {
          const command = request.postDataJSON();
          if (command.action === 'end') {
            const end = { roomId: String(command.roomId), startedAt: request.timing().startTime, applied: false }; ends.push(end);
            inspections.push(response.json().then(body => { end.applied = body.outcome === 'applied'; }));
          }
        }
        if (path.startsWith('/api/social/') && response.status() >= 400) {
          const failure = { method: request.method(), path, status: response.status() }; failures.push(failure);
          const match = /^\/api\/social\/v1\/rooms\/(r_[A-Za-z0-9_-]+)\/community$/.exec(path);
          if (request.method() === 'GET' && response.status() === 404 && match) {
            const read = { failure, roomId: match[1], admitted: admittedReads.get(request) === match[1], respondedAt: Date.now(), body: undefined as unknown };
            retiringReads.push(read); inspections.push(response.json().then(body => { read.body = body; }));
          }
        }
        else if (response.status() >= 500) otherServerFailures.push({ method: response.request().method(), path, status: response.status() });
        if (path === '/api/social/v1/listening-status/query' && response.ok()) inspections.push((async () => {
          const body = await response.json();
          if (Object.keys(body).join() !== 'items' || !Array.isArray(body.items)) { privacyErrors.push('Invalid public listening envelope'); return; }
          for (const item of body.items) {
            if (Object.keys(item).sort().join() !== 'expiresAtMs,peer,track') privacyErrors.push('Unexpected public listening fields');
            if (Object.keys(item.peer).sort().join() !== 'alias,handle,iconSeed,socialId') privacyErrors.push('Unexpected friend identity fields');
            if (Object.keys(item.track).sort().join() !== 'artistNames,artworkUrl,contentType,id,title') privacyErrors.push('Unexpected public Audio fields');
            if (item.track.contentType !== 'audioTrack' || !Number.isSafeInteger(item.expiresAtMs)) privacyErrors.push('Invalid public Audio status');
          }
        })().catch(() => { privacyErrors.push('Public listening response could not be decoded'); }));
      });
    }
    const first = await contexts[0].newPage(); friend = await contexts[1].newPage();
    const friendRoom = observeRoom(friend);
    roomObservers.set(friend, friendRoom);
    await login(first, 'invitation_host', baseURL!);
    await expect(sharing(first).getByRole('button', { name: 'Enable listening sharing', exact: true })).toBeVisible();
    await login(friend, 'invitation_guest', baseURL!);
    await expect(sharing(friend).getByRole('button', { name: 'Enable listening sharing', exact: true })).toBeVisible();
    await playCatalog(first, 'First Light');
    await refreshListening(friend);
    await expect(statusCard(friend)).toHaveCount(0);
    expect(claims).toEqual([0, 0, 0]); expect(reports).toEqual([]);
    expect(actions).toEqual([]); expect(saveWrites).toEqual([]);
    await silent(friend);

    await sharing(first).getByRole('button', { name: 'Enable listening sharing', exact: true }).click();
    await expect(sharing(first).getByRole('button', { name: 'Turn off listening sharing', exact: true })).toBeVisible();
    await expectStatus(friend, 'First Light');
    await expect(statusCard(friend).getByRole('button', { name: 'Create a room and invite', exact: true })).toBeVisible();
    await captureResponsive(friend, statusCard(friend), 'friend-listening-status');
    await captureResponsive(first, sharing(first), 'listening-sharing-settings');
    await playing(first, 'First Light'); await silent(friend);
    expect(reports.some(report => report.device === 0 && report.state === 'playing' && !report.room)).toBe(true);
    expect(actions).toEqual([]); expect(saveWrites).toEqual([]);

    await transport(first).getByRole('button', { name: 'Pause', exact: true }).click();
    await refreshListening(friend); await expect(statusCard(friend)).toHaveCount(0);
    await playCatalog(first, 'Across the Water');
    await expectStatus(friend, 'Across the Water');
    await expect(listening(friend).getByText('First Light', { exact: true })).toHaveCount(0);

    // A second real authenticated device claims on its own Play; an old native pause cannot clear it.
    const second = await contexts[2].newPage(); const secondRoom = observeRoom(second);
    roomObservers.set(second, secondRoom);
    await login(second, 'invitation_host', baseURL!);
    await expect(sharing(second).getByRole('button', { name: 'Turn off listening sharing', exact: true })).toBeVisible();
    await playCatalog(second, 'Home Again');
    await expectStatus(friend, 'Home Again');
    const oldClaims = claims[0];
    await transport(first).getByRole('button', { name: 'Pause', exact: true }).click();
    await refreshListening(friend); await expectStatus(friend, 'Home Again');
    expect(claims[0]).toBe(oldClaims);
    await first.close();

    // Actual network loss prevents the captured native stop from reaching the server.
    // The friend continues ordinary visible reads until the original short status expires.
    await contexts[2].setOffline(true);
    await transport(second).getByRole('button', { name: 'Pause', exact: true }).click();
    await silent(second);
    await listening(friend).scrollIntoViewIfNeeded();
    await expect(statusCard(friend)).toHaveCount(0, { timeout: 30_000 });
    expect(claims[0]).toBe(oldClaims);
    await contexts[2].setOffline(false);
    await transport(second).getByRole('button', { name: 'Play', exact: true }).click();
    await playing(second, 'Home Again'); await expectStatus(friend, 'Home Again');

    await statusCard(friend).getByRole('button', { name: 'Create a room and invite', exact: true }).click();
    const dialog = friend.getByRole('dialog', { name: 'Listen together with Invitation host?', exact: true });
    await expect(dialog).toContainText('Create a paused room with Home Again');
    await captureResponsive(friend, dialog, 'listening-create-invite');
    await silent(friend); expect(actions).toEqual([]);
    await dialog.getByRole('button', { name: 'Create paused room and invite', exact: true }).click();
    await expect(dialog).toHaveCount(0); created = true;
    await expect.poll(() => friendRoom()?.timeline?.state).toBe('paused');
    await expect.poll(secondRoom).toBeNull();
    expect(actions).toEqual(['create', 'invite']);
    await silent(friend);

    await roomPanel(second).getByRole('button', { name: 'Join room', exact: true }).click();
    await expect.poll(() => secondRoom()?.members.length).toBe(2);
    for (const page of [friend, second]) {
      const listen = roomPanel(page).getByRole('button', { name: 'Listen along', exact: true });
      if (await listen.isVisible()) await listen.click();
    }
    await expect.poll(() => secondRoom()?.members.find(member => member.memberId === secondRoom()?.self.memberId)?.ready).toBe(true);
    await Promise.all([silent(friend), silent(second)]);
    await refreshListening(friend); await expect(statusCard(friend)).toHaveCount(0);
    expect(reports.filter(report => report.room && report.state === 'playing')).toEqual([]);
    // An explicit sharing gesture renews the publisher after readiness; it still cannot manufacture playback.
    await sharing(second).getByRole('button', { name: 'Share from this device', exact: true }).click();
    await roomPanel(friend).getByRole('button', { name: 'Play for everyone', exact: true }).click();
    await Promise.all([playing(friend, 'Home Again'), playing(second, 'Home Again')]);
    await expectStatus(friend, 'Home Again');
    expect(reports.some(report => report.device === 2 && report.state === 'playing' && report.room)).toBe(true);
    expect(reports.filter(report => report.device === 1)).toEqual([]);
    expect(saveWrites).toEqual([]);
    await roomPanel(friend).getByRole('button', { name: 'Pause for everyone', exact: true }).click();
    await Promise.all([silent(friend), silent(second)]);
    await refreshListening(friend); await expect(statusCard(friend)).toHaveCount(0);
    await endRoom(friend); created = false;
    await expect.poll(friendRoom).toBeNull(); await expect.poll(secondRoom).toBeNull();
    for (const page of [friend, second]) await expect(roomPanel(page).getByRole('button', { name: 'Start a room', exact: true })).toBeVisible();
    await sharing(second).getByRole('button', { name: 'Turn off listening sharing', exact: true }).click();
    await expect(sharing(second).getByRole('button', { name: 'Enable listening sharing', exact: true })).toBeVisible();
    await refreshListening(friend); await expect(statusCard(friend)).toHaveCount(0);
    await expect.poll(() => pendingRoomReads.size).toBe(0);
    await Promise.all(inspections);
    for (const read of retiringReads) {
      // A peer may still be admitted locally while another client's End commits.
      // After its own authoritative null snapshot, every newly dispatched read remains a failure.
      if (!read.admitted || !ends.some(end => end.applied && end.roomId === read.roomId
        && end.startedAt > 0 && read.respondedAt >= end.startedAt)) continue;
      expect(read.body).toEqual({ code: 'room_unavailable', message: 'The social request could not be completed.' });
      failures.splice(failures.indexOf(read.failure), 1);
    }
    expect(privacyErrors).toEqual([]); expect(failures).toEqual([]);
  } finally {
    if (failures.length) console.log(`Listening status HTTP failures: ${JSON.stringify(failures)}`);
    if (otherServerFailures.length) console.log(`Other HTTP server failures: ${JSON.stringify(otherServerFailures)}`);
    try { if (created && friend) await endRoom(friend).catch(() => undefined); }
    finally { await Promise.all(contexts.map(context => context.close())); }
  }
});
