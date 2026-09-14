import { expect, test, type Page, type Route } from '@playwright/test';
import type { RoomSnapshot } from '../src/api/rooms';
import { expectNoUnownedAxeViolations } from '../e2e/support/accessibility';

const roomPanel = (page: Page) => page.getByRole('region', { name: 'Listening room' });
const media = (page: Page) => page.locator('video').evaluateAll((elements: HTMLVideoElement[]) => elements.map(element => ({
  source: element.currentSrc, paused: element.paused, time: element.currentTime, ready: element.readyState
})));
const playing = async (page: Page) => {
  await expect.poll(async () => (await media(page)).filter(value => !value.paused && value.ready >= 2).length).toBe(1);
};

/** Retains native close diagnostics without changing socket arguments or transport behavior. */
const observeTransportCloses = (page: Page) => page.addInitScript(() => {
  const closes: Array<{ code: number; reason: string; at: number }> = [];
  Object.defineProperty(window, '__socialSocketCloses', { value: closes });
  window.WebSocket = new Proxy(WebSocket, { construct(target, argumentsList) {
    const socket: WebSocket = Reflect.construct(target, argumentsList);
    socket.addEventListener('close', event => closes.push({ code: event.code, reason: event.reason, at: Date.now() }));
    return socket;
  } });
});
const transportCloses = (page: Page) => page.evaluate(() => (window as unknown as { __socialSocketCloses?: unknown[] }).__socialSocketCloses ?? []);

/** Observes real protocol frames without replacing the socket or browser media implementation. */
const snapshots = (page: Page) => {
  let current: RoomSnapshot | null = null;
  const frames: Array<Record<string, unknown>> = [];
  page.on('websocket', socket => {
    socket.on('close', () => frames.push({ type: 'socket-closed', at: Date.now() }));
    socket.on('framesent', frame => {
      const message = JSON.parse(String(frame.payload));
      if (message.type === 'ready') frames.push({ type: 'ready', at: Date.now(), preparationId: message.report.preparationId,
        generation: message.report.playbackGeneration, ready: message.report.ready });
      if (message.type === 'ping' && message.heartbeat) frames.push({ type: 'heartbeat', at: Date.now(), locallyPaused: message.heartbeat.locallyPaused });
    });
    socket.on('framereceived', frame => {
    const message = JSON.parse(String(frame.payload));
      if (message.type === 'subscribed' || message.type === 'snapshot') {
        current = message.room;
        frames.push({ type: 'snapshot', at: Date.now(), generation: current?.timeline?.playbackGeneration, state: current?.timeline?.state,
          ready: current?.members.find(member => member.memberId === current?.self.memberId)?.ready });
      }
    });
  });
  return Object.assign(() => current, { frames });
};
const login = async (page: Page, name: string, alias: string) => {
  await page.goto('/finitude/login');
  await page.getByLabel('Email or username').fill(`${name}@example.test`);
  await page.getByLabel('Password', { exact: true }).fill('Social-real-browser-2026!');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page).not.toHaveURL(/\/login/);
  await page.goto('/finitude/social');
  await expect(page).toHaveTitle('Listen together · Finitude');
  const identity = page.getByRole('form', { name: 'Your social profile' });
  await identity.getByLabel('Handle', { exact: true }).fill(name);
  await identity.getByLabel('Display name', { exact: true }).fill(alias);
  await identity.getByRole('button', { name: 'Create social profile' }).click();
  await expect(identity.getByRole('button', { name: 'Save profile' })).toBeVisible();
};

/** Holds only dispatch timing; both original UI commands still execute on the actual server. */
const raceCommands = async (first: Page, second: Page, firstGesture: () => Promise<void>, secondGesture: () => Promise<void>) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const captured: Array<Record<string, unknown>> = [];
  const outcomes: string[] = [];
  const route = async (request: Route) => {
    captured.push(request.request().postDataJSON());
    if (captured.length === 2) release();
    await gate;
    const response = await request.fetch();
    outcomes.push((await response.json()).outcome);
    await request.fulfill({ response });
  };
  await first.route('**/api/social/v1/room-commands', route);
  await second.route('**/api/social/v1/room-commands', route);
  try {
    await Promise.all([firstGesture(), secondGesture()]);
    await expect.poll(() => outcomes.length).toBe(2);
    expect(captured[0].expectedPlaybackGeneration).toBe(captured[1].expectedPlaybackGeneration);
    expect(captured[0].expectedEntryId).toBe(captured[1].expectedEntryId);
    expect(outcomes.sort()).toEqual(['applied', 'rejected']);
  } finally {
    release();
    await first.unroute('**/api/social/v1/room-commands', route);
    await second.unroute('**/api/social/v1/room-commands', route);
  }
};

test('real social route joins one player, arbitrates concurrent gestures, resyncs locally and transfers the host', async ({ browser, baseURL }) => {
  const contexts = await Promise.all([browser.newContext({ baseURL, reducedMotion: 'reduce' }), browser.newContext({ baseURL, reducedMotion: 'reduce' })]);
  const [alice, bob] = await Promise.all(contexts.map(context => context.newPage()));
  await Promise.all([observeTransportCloses(alice), observeTransportCloses(bob)]);
  const aliceRoom = snapshots(alice); const bobRoom = snapshots(bob);
  const commands: string[] = [];
  const failures: Array<{ path: string; status: number; code?: string }> = [];
  for (const page of [alice, bob]) page.on('request', request => {
    if (request.url().endsWith('/api/social/v1/room-commands')) commands.push(request.postDataJSON().action);
  });
  for (const page of [alice, bob]) page.on('response', async response => {
    const path = new URL(response.url()).pathname;
    if (path.startsWith('/api/social/') && response.status() >= 400) {
      const body = await response.json().catch(() => ({}));
      failures.push({ path, status: response.status(), code: body.code });
    }
  });
  try {
    await Promise.all([login(alice, 'listener_one', 'Listener One'), login(bob, 'listener_two', 'Listener Two')]);
    const lookup = alice.getByRole('form', { name: 'Find a friend' });
    await lookup.getByLabel('Handle', { exact: true }).fill('listener_two');
    await lookup.getByRole('button', { name: 'Find', exact: true }).click();
    await alice.getByRole('button', { name: 'Add friend', exact: true }).click();
    await bob.getByRole('tab', { name: 'Incoming requests' }).click();
    await bob.getByRole('button', { name: 'Accept', exact: true }).click();
    await expect(bob.getByRole('button', { name: 'Accept', exact: true })).toHaveCount(0);
    await expect(alice.getByRole('button', { name: 'Remove friend', exact: true })).toBeVisible();
    await alice.getByRole('tab', { name: 'Friends', exact: true }).click();
    const a = roomPanel(alice); const b = roomPanel(bob);
    for (const title of ['First Light', 'Across the Water', 'Home Again']) await a.getByRole('checkbox', { name: new RegExp(title) }).check();
    await a.getByRole('button', { name: 'Start a room', exact: true }).click();
    await expect(a.getByRole('button', { name: 'End room', exact: true })).toBeVisible();
    const invitedAt = Date.now();
    await a.getByRole('button', { name: 'Invite', exact: true }).click();
    await expect(b.getByRole('button', { name: 'Join room', exact: true })).toBeVisible({ timeout: 5000 });
    expect(Date.now() - invitedAt).toBeLessThan(5000);
    await b.getByRole('button', { name: 'Join room', exact: true }).click();
    await expect.poll(() => bobRoom()?.members.length).toBe(2);
    for (const panel of [a, b]) {
      const listen = panel.getByRole('button', { name: 'Listen along', exact: true });
      if (await listen.isVisible()) await listen.click();
    }
    await expect.poll(() => ['playing', 'paused'].includes(aliceRoom()?.timeline?.state ?? '')).toBe(true);
    if (aliceRoom()?.timeline?.state === 'paused') await a.getByRole('button', { name: 'Play for everyone', exact: true }).click();
    await Promise.all([playing(alice), playing(bob)]);
    await expectNoUnownedAxeViolations(alice, 'social-room-live');
    await expect(b.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
    await a.getByLabel('Playback control').selectOption('everyone');
    await expect(b.getByRole('button', { name: 'Next', exact: true })).toBeEnabled();
    const generation = aliceRoom()!.timeline!.playbackGeneration;
    await raceCommands(alice, bob, () => a.getByRole('button', { name: 'Next', exact: true }).click(), () => b.getByRole('button', { name: 'Next', exact: true }).click());
    await expect.poll(() => aliceRoom()?.timeline?.playbackGeneration).toBe(generation + 1);
    await expect.poll(() => bobRoom()?.timeline?.entryId).toBe(aliceRoom()!.queue[1].entryId);
    await Promise.all([playing(alice), playing(bob)]);
    const nextGeneration = aliceRoom()!.timeline!.playbackGeneration;
    await raceCommands(alice, bob,
      () => a.getByRole('button', { name: 'Play for everyone First Light', exact: true }).click(),
      () => b.getByRole('button', { name: 'Play for everyone Home Again', exact: true }).click());
    await expect.poll(() => aliceRoom()?.timeline?.playbackGeneration).toBe(nextGeneration + 1);
    await expect.poll(() => bobRoom()?.timeline?.entryId).toBe(aliceRoom()!.timeline!.entryId);
    await Promise.all([playing(alice), playing(bob)]);
    const beforeLocalPause = commands.length;
    await b.getByRole('button', { name: 'Pause only for me', exact: true }).click();
    await expect.poll(async () => (await media(bob))[0]?.paused).toBe(true);
    await playing(alice);
    expect(commands).toHaveLength(beforeLocalPause);
    await a.getByRole('button', { name: 'Pause for everyone', exact: true }).click();
    await a.getByRole('button', { name: 'Play for everyone', exact: true }).click();
    await playing(alice);
    expect((await media(bob))[0].paused).toBe(true);
    await b.getByRole('button', { name: 'Listen along', exact: true }).click();
    await playing(bob);
    const drift = Math.abs((await media(alice))[0].time - (await media(bob))[0].time);
    expect(drift).toBeLessThan(0.75);
    expect(aliceRoom.frames.filter(frame => frame.type === 'socket-closed')).toHaveLength(0);
    expect(bobRoom.frames.filter(frame => frame.type === 'socket-closed')).toHaveLength(0);
    console.log(`Real room resynchronization drift: ${Math.round(drift * 1000)} ms.`);
    await alice.reload();
    await expect(roomPanel(alice).getByRole('button', { name: 'Use this device', exact: true })).toBeVisible();
    expect((await media(alice)).filter(value => !value.paused)).toHaveLength(0);
    await roomPanel(alice).getByRole('button', { name: 'Use this device', exact: true }).click();
    await expect.poll(() => aliceRoom()?.self.isController).toBe(true);
    await playing(alice);
    await a.getByRole('button', { name: 'Transfer and leave', exact: true }).click();
    await b.getByRole('button', { name: 'Accept host role', exact: true }).click();
    await expect(b.getByRole('button', { name: 'End room', exact: true })).toBeVisible();
    await expect.poll(() => aliceRoom()).toBeNull();
    await expect(a.getByRole('button', { name: 'Start a room', exact: true })).toBeVisible();
    await expect.poll(async () => (await media(alice))[0]?.paused).toBe(true);
    await b.getByLabel('Playback control').selectOption('hostOnly');
    await b.getByRole('button', { name: 'Invite', exact: true }).click();
    await a.getByRole('button', { name: 'Join room', exact: true }).click();
    await expect.poll(() => aliceRoom()?.members.length).toBe(2);
    await expect(a.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
    // A completed transfer preserves the running timeline; the returning guest readies against it.
    await Promise.all([playing(alice), playing(bob)]);
    const beforeEnd = commands.length;
    bob.once('dialog', dialog => dialog.accept());
    await b.getByRole('button', { name: 'End room', exact: true }).click();
    await expect.poll(() => aliceRoom()).toBeNull();
    await expect.poll(() => bobRoom()).toBeNull();
    await expect.poll(async () => (await media(alice))[0]?.paused).toBe(true);
    await expect.poll(async () => (await media(bob))[0]?.paused).toBe(true);
    expect(commands.slice(beforeEnd)).toEqual(['end']);
    expect((await media(alice))).toHaveLength(1);
    expect((await media(bob))).toHaveLength(1);
  } finally {
    await test.info().attach('playback-state', { body: JSON.stringify({
      alice: { room: aliceRoom(), media: await media(alice), visibility: await alice.evaluate(() => document.visibilityState), frames: aliceRoom.frames, closes: await transportCloses(alice) },
      bob: { room: bobRoom(), media: await media(bob), visibility: await bob.evaluate(() => document.visibilityState), frames: bobRoom.frames, closes: await transportCloses(bob) }, failures
    }), contentType: 'application/json' });
    await Promise.all(contexts.map(context => context.close()));
  }
});
