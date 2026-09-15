import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test';
import { nativeSocialBrowser } from './support/nativeSocialBrowser';
import type { RoomSnapshot } from '../src/api/rooms';
import { expectNoUnownedAxeViolations } from '../e2e/support/accessibility';

const roomPanel = (page: Page) => page.getByRole('region', { name: 'Listening room' });
const media = (page: Page) => page.locator('video').evaluateAll((elements: HTMLVideoElement[]) => elements.map(element => ({
  source: element.currentSrc, paused: element.paused, time: element.currentTime, ready: element.readyState, muted: element.muted, volume: element.volume
})));
const playing = async (page: Page) => {
  await expect.poll(async () => (await media(page)).filter(value => !value.paused && value.ready >= 2).length).toBe(1);
};

/** Checks the actual controls at desktop and mobile widths without changing room state. */
const roomSettingsGeometry = async (page: Page) => {
  const original = page.viewportSize()!;
  const panel = roomPanel(page);
  const select = panel.getByRole('combobox', { name: 'Playback control' });
  const end = panel.getByRole('button', { name: 'End room', exact: true });
  try {
    for (const [name, viewport] of [['desktop', original], ['320', { width: 320, height: 800 }]] as const) {
      await page.setViewportSize(viewport);
      await expect.poll(async () => {
        const [field, button, bounds] = await Promise.all([select.boundingBox(), end.boundingBox(), panel.evaluate(element => {
          const rect = element.getBoundingClientRect(); const style = getComputedStyle(element);
          return { left: rect.left + parseFloat(style.paddingLeft), right: rect.right - parseFloat(style.paddingRight),
            viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth };
        })]);
        if (!field || !button) return false;
        const aligned = Math.abs(field.y + field.height - button.y - button.height) <= 1;
        const wrapped = name === '320' && button.y >= field.y + field.height - 1;
        return (aligned || wrapped) && Math.abs(field.height - button.height) <= 1
          && [field, button].every(box => box.x >= bounds.left - 1 && box.x + box.width <= bounds.right + 1)
          && Math.max(bounds.document, bounds.body) <= bounds.viewport + 1;
      }, { message: `${name}: room settings align or wrap within the viewport` }).toBe(true);
      const path = test.info().outputPath(`room-settings-${name}.png`);
      await select.locator('..').locator('..').screenshot({ path, animations: 'disabled' });
      await test.info().attach(`room-settings-${name}`, { path, contentType: 'image/png' });
    }
  } finally { await page.setViewportSize(original); }
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
const login = async (page: Page, name: string, alias: string, baseURL: string) => {
  await page.goto(new URL('/finitude/login', baseURL).href);
  await page.getByLabel('Email or username').fill(`${name}@example.test`);
  await page.getByLabel('Password', { exact: true }).fill('Social-real-browser-2026!');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page).not.toHaveURL(/\/login/);
  await page.goto(new URL('/finitude/social', baseURL).href);
  await expect(page).toHaveTitle('Listen together · Finitude');
  const identity = page.getByRole('form', { name: 'Your social profile' });
  await identity.getByLabel('Handle', { exact: true }).fill(name);
  await identity.getByLabel('Display name', { exact: true }).fill(alias);
  await identity.getByRole('button', { name: 'Create social profile' }).click();
  await expect(identity.getByRole('button', { name: 'Save profile' })).toBeVisible();
};

/** Keep interception for the context lifetime: toggling it during polling can strand unrelated Chromium reads. */
const installCommandRace = async (first: Page, second: Page) => {
  let intercept: ((request: Route) => Promise<void>) | undefined;
  const route = (request: Route) => intercept ? intercept(request) : request.continue();
  await first.route('**/api/social/v1/room-commands', route);
  await second.route('**/api/social/v1/room-commands', route);
  return async (firstGesture: () => Promise<void>, secondGesture: () => Promise<void>) => {
    expect(intercept).toBeUndefined();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const captured: Array<Record<string, unknown>> = [];
    const outcomes: Array<{ status: number; outcome?: string; code?: string }> = [];
    // Only dispatch timing is held; both original UI commands still execute on the actual server.
    intercept = async request => {
      captured.push(request.request().postDataJSON());
      if (captured.length === 2) release();
      await gate;
      const response = await request.fetch();
      const body = await response.json();
      await request.fulfill({ response });
      outcomes.push({ status: response.status(), outcome: body.outcome, code: body.code });
    };
    try {
      await Promise.all([firstGesture(), secondGesture()]);
      await expect.poll(() => outcomes.length).toBe(2);
      expect(captured).toHaveLength(2);
      expect(captured[0].expectedPlaybackGeneration).toBe(captured[1].expectedPlaybackGeneration);
      expect(captured[0].expectedEntryId).toBe(captured[1].expectedEntryId);
      expect(outcomes.map(value => value.outcome).sort(), JSON.stringify(outcomes)).toEqual(['applied', 'rejected']);
    } finally { release(); intercept = undefined; }
  };
};

test('real social route continues background audio, arbitrates gestures, recovers locally and transfers the host', async ({ browser, baseURL }) => {
  const native = await nativeSocialBrowser();
  let aliceContext: BrowserContext | undefined;
  try {
    aliceContext = await browser.newContext({ baseURL, reducedMotion: 'reduce' });
    const contexts = [aliceContext, native.context];
    const [alice, bob] = await Promise.all(contexts.map(context => context.newPage()));
    const raceCommands = await installCommandRace(alice, bob);
    await Promise.all([observeTransportCloses(alice), observeTransportCloses(bob)]);
    const aliceRoom = snapshots(alice); const bobRoom = snapshots(bob);
    const commands: string[] = [];
    const backgroundEvidence: Array<Record<string, unknown>> = [];
    let phase = 'setup';
    const failures: Array<{ path: string; status: number; code?: string; phase: string }> = [];
    for (const page of [alice, bob]) page.on('request', request => {
      if (request.url().endsWith('/api/social/v1/room-commands')) commands.push(request.postDataJSON().action);
    });
    for (const page of [alice, bob]) page.on('response', async response => {
      const path = new URL(response.url()).pathname;
      if (['/api/', '/content/', '/finitude/'].some(prefix => path.startsWith(prefix)) && response.status() >= 400) {
        const body = await response.json().catch(() => ({}));
        failures.push({ path, status: response.status(), code: typeof body.code === 'string' ? body.code : undefined, phase });
      }
    });
    try {
      await Promise.all([login(alice, 'listener_one', 'Listener One', baseURL!), login(bob, 'listener_two', 'Listener Two', baseURL!)]);
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
      await roomSettingsGeometry(alice);
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
      await expect.poll(() => aliceRoom()?.timeline?.state).toBe('paused');
      const beforeGuestRecovery = commands.length;
      await b.getByRole('button', { name: 'Pause only for me', exact: true }).click();
      await b.getByRole('button', { name: 'Listen along', exact: true }).click();
      await expect(b.getByText(/^Waiting for the host to start playback\.?$/)).toBeVisible();
      await expect.poll(() => bobRoom()?.members.find(member => member.memberId === bobRoom()?.self.memberId)?.ready).toBe(true);
      expect((await media(bob))[0].paused).toBe(true);
      expect(commands).toHaveLength(beforeGuestRecovery);
      await expect.poll(() => ['playing', 'paused'].includes(aliceRoom()?.timeline?.state ?? '')).toBe(true);
      if (aliceRoom()?.timeline?.state === 'paused') await a.getByRole('button', { name: 'Play for everyone', exact: true }).click();
      await Promise.all([playing(alice), playing(bob)]);
      // A real sibling tab, not an emulated visibility value, puts the playing Audio page in the background.
      phase = 'background-audio';
      const hiddenFramesStart = bobRoom.frames.length;
      const background = await native.context.newPage(); await background.goto('about:blank'); await background.bringToFront();
      await expect.poll(() => bob.evaluate(() => document.visibilityState)).toBe('hidden');
      const hiddenTime = (await media(bob))[0].time;
      await expect.poll(async () => (await media(bob))[0].time - hiddenTime).toBeGreaterThan(1);
      expect((await media(bob))[0]).toMatchObject({ paused: false, muted: false });
      expect((await media(bob))[0].volume).toBeGreaterThan(0);
      backgroundEvidence.push({ state: 'hidden-playing', visibility: await bob.evaluate(() => document.visibilityState),
        elapsedSeconds: (await media(bob))[0].time - hiddenTime, media: await media(bob) });
      await a.getByRole('button', { name: 'Pause for everyone', exact: true }).click();
      await expect.poll(async () => (await media(bob))[0].paused).toBe(true);
      await expect.poll(() => bobRoom()?.timeline?.state).toBe('paused');
      backgroundEvidence.push({ state: 'hidden-shared-pause', visibility: await bob.evaluate(() => document.visibilityState), media: await media(bob) });
      const hiddenResumeCommands = commands.length;
      await a.getByRole('button', { name: 'Play for everyone', exact: true }).click();
      await Promise.all([playing(alice), playing(bob)]);
      expect(commands.slice(hiddenResumeCommands)).toEqual(['play']);
      await expect.poll(() => bob.evaluate(() => document.visibilityState)).toBe('hidden');
      backgroundEvidence.push({ state: 'hidden-shared-resume', visibility: await bob.evaluate(() => document.visibilityState), media: await media(bob) });
      await bob.bringToFront();
      await expect.poll(() => bob.evaluate(() => document.visibilityState)).toBe('visible');
      await playing(bob);
      await expect(b.getByRole('button', { name: 'Listen along', exact: true })).toHaveCount(0);
      backgroundEvidence.push({ state: 'visible-playing', visibility: await bob.evaluate(() => document.visibilityState), media: await media(bob) });
      expect(bobRoom.frames.slice(hiddenFramesStart).filter(frame => frame.type === 'heartbeat' && frame.locallyPaused === true)).toHaveLength(0);
      await background.close();
      await expectNoUnownedAxeViolations(alice, 'social-room-live');
      await expect(b.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
      await a.getByLabel('Playback control').selectOption('everyone');
      phase = 'concurrent-commands';
      await expect(b.getByRole('button', { name: 'Next', exact: true })).toBeEnabled();
      const generation = aliceRoom()!.timeline!.playbackGeneration;
      await raceCommands(() => a.getByRole('button', { name: 'Next', exact: true }).click(), () => b.getByRole('button', { name: 'Next', exact: true }).click());
      await expect.poll(() => aliceRoom()?.timeline?.playbackGeneration).toBe(generation + 1);
      await expect.poll(() => bobRoom()?.timeline?.entryId).toBe(aliceRoom()!.queue[1].entryId);
      await Promise.all([playing(alice), playing(bob)]);
      const nextGeneration = aliceRoom()!.timeline!.playbackGeneration;
      await raceCommands(
        () => a.getByRole('button', { name: 'Play for everyone First Light', exact: true }).click(),
        () => b.getByRole('button', { name: 'Play for everyone Home Again', exact: true }).click());
      await expect.poll(() => aliceRoom()?.timeline?.playbackGeneration).toBe(nextGeneration + 1);
      await expect.poll(() => bobRoom()?.timeline?.entryId).toBe(aliceRoom()!.timeline!.entryId);
      await Promise.all([playing(alice), playing(bob)]);
      const beforeLocalPause = commands.length;
      phase = 'local-recovery';
      await b.getByRole('button', { name: 'Pause only for me', exact: true }).click();
      await expect.poll(async () => (await media(bob))[0]?.paused).toBe(true);
      await playing(alice);
      expect(commands).toHaveLength(beforeLocalPause);
      await a.getByRole('button', { name: 'Pause for everyone', exact: true }).click();
      await a.getByRole('button', { name: 'Play for everyone', exact: true }).click();
      await playing(alice);
      expect((await media(bob))[0].paused).toBe(true);
      const beforeListenAlong = commands.length;
      await b.getByRole('button', { name: 'Listen along', exact: true }).click();
      await playing(bob);
      expect(commands).toHaveLength(beforeListenAlong);
      await b.getByRole('button', { name: 'Pause only for me', exact: true }).click();
      await expect.poll(async () => (await media(bob))[0].paused).toBe(true);
      await a.getByRole('button', { name: 'Pause for everyone', exact: true }).click();
      await expect.poll(() => bobRoom()?.timeline?.state).toBe('paused');
      const beforeResumeEveryone = commands.length;
      await b.getByRole('button', { name: 'Resume and play for everyone', exact: true }).click();
      await Promise.all([playing(alice), playing(bob)]);
      expect(commands.slice(beforeResumeEveryone)).toEqual(['play']);
      const drift = Math.abs((await media(alice))[0].time - (await media(bob))[0].time);
      expect(drift).toBeLessThan(0.75);
      expect(aliceRoom.frames.filter(frame => frame.type === 'socket-closed')).toHaveLength(0);
      expect(bobRoom.frames.filter(frame => frame.type === 'socket-closed')).toHaveLength(0);
      console.log(`Real room resynchronization drift: ${Math.round(drift * 1000)} ms.`);
      // Actual browser freezing is a stronger lifecycle boundary than ordinary tab visibility.
      phase = 'freeze';
      const freezeTab = await native.context.newPage(); await freezeTab.bringToFront();
      await expect.poll(() => bob.evaluate(() => document.visibilityState)).toBe('hidden');
      const lifecycle = await native.context.newCDPSession(bob);
      const beforeFreezeCommands = commands.length;
      const beforeFreezeSnapshots = bobRoom.frames.filter(frame => frame.type === 'snapshot').length;
      try {
        await lifecycle.send('Page.setWebLifecycleState', { state: 'frozen' });
        // The frozen renderer defers its own close notification; the peer's authorized state proves disconnection now.
        await expect.poll(() => aliceRoom()?.members.find(member => member.memberId === bobRoom()?.self.memberId)?.connected).toBe(false);
      } finally {
        await lifecycle.send('Page.setWebLifecycleState', { state: 'active' });
        await bob.bringToFront(); await freezeTab.close(); await lifecycle.detach();
      }
      await expect.poll(() => bobRoom.frames.filter(frame => frame.type === 'socket-closed').length).toBe(1);
      phase = 'post-freeze-recovery';
      await expect.poll(() => bobRoom.frames.filter(frame => frame.type === 'snapshot').length).toBeGreaterThan(beforeFreezeSnapshots);
      await expect(b.getByRole('button', { name: 'Listen along', exact: true })).toBeEnabled();
      expect((await media(bob))[0].paused).toBe(true);
      await playing(alice);
      expect(commands).toHaveLength(beforeFreezeCommands);
      await b.getByRole('button', { name: 'Listen along', exact: true }).click();
      await Promise.all([playing(alice), playing(bob)]);
      expect(commands).toHaveLength(beforeFreezeCommands);
      phase = 'reload';
      await alice.reload();
      await expect(roomPanel(alice).getByRole('button', { name: 'Use this device', exact: true })).toBeVisible();
      expect((await media(alice)).filter(value => !value.paused)).toHaveLength(0);
      await roomPanel(alice).getByRole('button', { name: 'Use this device', exact: true }).click();
      await expect.poll(() => aliceRoom()?.self.isController).toBe(true);
      await playing(alice);
      phase = 'transfer-and-reinvite';
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
      phase = 'end';
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
      if (failures.length) console.log(`Non-success browser responses: ${JSON.stringify(failures)}`);
      await test.info().attach('playback-state', { body: JSON.stringify({
        alice: { room: aliceRoom(), media: await media(alice).catch(() => []), visibility: await alice.evaluate(() => document.visibilityState).catch(() => 'unavailable'), frames: aliceRoom.frames, closes: await transportCloses(alice).catch(() => []) },
        bob: { room: bobRoom(), media: await media(bob).catch(() => []), visibility: await bob.evaluate(() => document.visibilityState).catch(() => 'unavailable'), frames: bobRoom.frames, closes: await transportCloses(bob).catch(() => []) }, failures, backgroundEvidence
      }), contentType: 'application/json' });
    }
  } finally {
    await Promise.all([aliceContext?.close(), native.close()]);
  }
});
