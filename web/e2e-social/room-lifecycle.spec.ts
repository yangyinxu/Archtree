import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import type { RoomSnapshot } from '../src/api/rooms';
import { expectNoUnownedAxeViolations } from '../e2e/support/accessibility';

const roomPanel = (page: Page) => page.getByRole('region', { name: 'Listening room', exact: true });
const media = (page: Page) => page.locator('audio, video').evaluateAll(elements => elements.map(element => {
  const value = element as HTMLMediaElement;
  return { paused: value.paused, ready: value.readyState, time: value.currentTime };
}));
const playing = async (page: Page) => {
  await expect.poll(async () => (await media(page)).filter(value => !value.paused && value.ready >= 2).length).toBe(1);
};
/** Actual media-clock advancement, separately from the element's paused flag. */
const advancing = async (page: Page) => {
  await playing(page);
  const before = (await media(page))[0].time;
  await expect.poll(async () => (await media(page))[0]?.time ?? 0).toBeGreaterThan(before + .5);
};
const silent = async (page: Page) => {
  await expect.poll(async () => (await media(page)).every(value => value.paused)).toBe(true);
};

/** Reads actual server frames; no socket, command, timer or snapshot is replaced. */
const observeRoom = (page: Page) => {
  let current: RoomSnapshot | null = null;
  page.on('websocket', socket => socket.on('framereceived', frame => {
    const message = JSON.parse(String(frame.payload));
    if (message.type === 'subscribed' || message.type === 'snapshot') current = message.room;
  }));
  return () => current;
};

/** Each context is its own login session, so a second context is a separate observer session. */
const signIn = async (page: Page, username: string, baseURL: string) => {
  await page.goto(new URL('/finitude/login', baseURL).href);
  await page.getByLabel('Email or username').fill(`${username}@example.test`);
  await page.getByLabel('Password', { exact: true }).fill('Social-real-browser-2026!');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page).not.toHaveURL(/\/login(?:[?#]|$)/);
  await page.goto(new URL('/finitude/social', baseURL).href);
  await expect(roomPanel(page)).toBeVisible();
};

/**
 * The fixture-only shortcut moves the recorded absence start into the past. Suspension and closure
 * still come from the application's own sweep and reach the browser as ordinary snapshots.
 */
const ageHostAbsence = async (baseURL: string, elapsedMs: number) => {
  const response = await fetch(new URL('/__fixture/room-host-absence', baseURL), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ elapsedMs })
  });
  expect(response.status, `age host absence to ${elapsedMs} ms`).toBe(204);
};

/** A device that was paused locally offers one combined resume-and-start action instead of Play. */
const sharedStart = /^(Resume and play|Play) for everyone$/;
const graceText = /^The host is disconnected\. Shared playback will be suspended in 0:[0-3]\d unless the host returns\.$/;

test('host absence suspends and ends rooms in both modes while observer logout and sign out everywhere differ', async ({ browser, baseURL }, testInfo) => {
  // One real 30-second grace plus three rooms; the five-minute boundary itself uses the fixture shortcut.
  test.setTimeout(240_000);
  const contexts: BrowserContext[] = [];
  const newPage = async () => {
    const context = await browser.newContext({ baseURL, reducedMotion: 'reduce' });
    contexts.push(context);
    return context.newPage();
  };
  let phase = 'setup';
  const commands: string[] = [];
  try {
    const [host, guest] = [await newPage(), await newPage()];
    const hostState = observeRoom(host); const guestState = observeRoom(guest);
    for (const page of [host, guest]) page.on('request', request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/social/v1/room-commands') {
        commands.push(`${page === host ? 'host' : 'guest'}:${request.postDataJSON().action}`);
      }
    });
    const a = roomPanel(host); const b = roomPanel(guest);
    const social = new URL('/finitude/social', baseURL).href;
    // These synthetic accounts have an established friendship; the host has exactly one friend to invite.
    await signIn(host, 'invitation_host', baseURL!);
    await signIn(guest, 'invitation_guest', baseURL!);

    /** A fresh Host-control room that is playing on both controllers. */
    const startPlayingRoom = async () => {
      for (const title of ['First Light', 'Across the Water']) await a.getByRole('checkbox', { name: new RegExp(title) }).check();
      await a.getByRole('button', { name: 'Start a room', exact: true }).click();
      await a.getByRole('button', { name: 'Invite', exact: true }).click();
      await b.getByRole('button', { name: 'Join room', exact: true }).click({ timeout: 20_000 });
      await expect.poll(() => hostState()?.members.length).toBe(2);
      for (const panel of [a, b]) {
        const listen = panel.getByRole('button', { name: 'Listen along', exact: true });
        if (await listen.isVisible()) await listen.click();
      }
      await expect.poll(() => guestState()?.members.find(member => member.memberId === guestState()?.self.memberId)?.ready).toBe(true);
      await a.getByRole('button', { name: sharedStart }).click();
      await Promise.all([advancing(host), advancing(guest)]);
    };

    phase = 'host-control-grace';
    await startPlayingRoom();
    expect(hostState()!.controlMode).toBe('hostOnly');
    // Leaving the document closes the host controller's socket; nothing else signals the server.
    await host.goto('about:blank');
    await expect.poll(() => guestState()?.hostAbsenceDeadlineMs ?? null).not.toBeNull();
    const timer = b.getByRole('timer');
    await expect(timer).toHaveText(graceText);
    const remaining = async () => Number((await timer.textContent())?.match(/ in 0:(\d\d) /)?.[1] ?? Number.NaN);
    const firstRemaining = await remaining();
    await expect.poll(remaining).toBeLessThan(firstRemaining);
    // The grace changes no shared playback: the guest's actual media keeps advancing on the same timeline.
    await advancing(guest);
    expect(guestState()).toMatchObject({ status: 'open', timeline: { state: 'playing' } });

    phase = 'host-control-suspension';
    // A real 30-second grace measured from the host's last heartbeat; the sweep checks every 250 ms.
    await expect.poll(() => guestState()?.status, { timeout: 40_000 }).toBe('suspended');
    const suspended = guestState()!;
    expect(suspended.serverTimeMs).toBeGreaterThanOrEqual(suspended.hostAbsenceDeadlineMs!);
    expect(suspended.serverTimeMs - suspended.hostAbsenceDeadlineMs!).toBeLessThan(5_000);
    expect(suspended.timeline!.state).toBe('paused');
    await silent(guest);
    await expect(timer).toHaveText(/^Shared playback is suspended\. The room ends in 4:[2-3]\d unless the host returns\.$/);
    await expectNoUnownedAxeViolations(guest, 'room-host-absence-suspended');

    phase = 'host-return';
    const beforeReturn = commands.length;
    await host.goto(social);
    await a.getByRole('button', { name: 'Use this device', exact: true }).click();
    await expect.poll(() => hostState()?.self.isController).toBe(true);
    await expect.poll(() => guestState()?.hostAbsenceDeadlineMs).toBeNull();
    // Reconnection neither resumes the suspended timeline nor changes the host.
    expect(guestState()).toMatchObject({ status: 'suspended', hostMemberId: hostState()!.self.memberId, timeline: { state: 'paused' } });
    await expect(b.getByText('Shared playback is suspended until the host starts it again.', { exact: true })).toBeVisible();
    await expect(a.getByText('Shared playback is suspended. Start playback for everyone when you are ready.', { exact: true })).toBeVisible();
    await expect(b.getByRole('timer')).toHaveCount(0);
    await Promise.all([silent(host), silent(guest)]);
    expect(commands.slice(beforeReturn)).toEqual(['host:takeControl']);
    await a.getByRole('button', { name: sharedStart }).click();
    await expect.poll(() => guestState()?.status).toBe('open');
    await Promise.all([advancing(host), advancing(guest)]);
    expect(commands.slice(beforeReturn)).toEqual(['host:takeControl', 'host:play']);

    phase = 'everyone-grace';
    await a.getByLabel('Playback control').selectOption('everyone');
    await expect(b.getByRole('button', { name: 'Next', exact: true })).toBeEnabled();
    await host.goto('about:blank');
    await expect(b.getByRole('timer')).toHaveText(graceText);
    // Inside the grace Everyone control keeps the guest's shared playback controls.
    await expect(b.getByRole('button', { name: 'Next', exact: true })).toBeEnabled();
    await advancing(guest);

    phase = 'everyone-suspension';
    await ageHostAbsence(baseURL!, 30_000);
    await expect.poll(() => guestState()?.status).toBe('suspended');
    await expect(b.getByRole('timer')).toHaveText(/^Shared playback is suspended\. The room ends in 4:[2-3]\d unless the host returns\.$/);
    // No snapshot arrives while the suspension holds. Leaving Together unmounts the countdown while the one
    // room transport stays connected, and returning must count from the snapshot's receipt, not restart it.
    const closingSeconds = async () => {
      const [, minutes, seconds] = (await b.getByRole('timer').textContent())?.match(/ends in (\d):(\d\d) /) ?? [];
      return Number(minutes) * 60 + Number(seconds);
    };
    const snapshotBeforeLeaving = guestState();
    const beforeLeaving = await closingSeconds();
    await guest.getByRole('link', { name: 'Search', exact: true }).click();
    await expect(b).toHaveCount(0);
    await guest.waitForTimeout(6_000);
    await guest.getByRole('link', { name: 'Together', exact: true }).click();
    await expect(b.getByRole('timer')).toHaveText(/^Shared playback is suspended\. The room ends in \d:\d\d unless the host returns\.$/);
    expect(guestState()).toBe(snapshotBeforeLeaving);
    expect(await closingSeconds()).toBeLessThanOrEqual(beforeLeaving - 5);
    // Everyone control does not bypass a suspension.
    for (const name of ['Previous', 'Next']) await expect(b.getByRole('button', { name, exact: true })).toBeDisabled();
    await expect(b.getByRole('button', { name: sharedStart })).toBeDisabled();
    await silent(guest);

    phase = 'everyone-close';
    const beforeClose = commands.length;
    await ageHostAbsence(baseURL!, 300_000);
    await expect.poll(() => guestState()).toBeNull();
    await expect(b.getByRole('button', { name: 'Start a room', exact: true })).toBeVisible();
    await silent(guest);
    expect(commands.slice(beforeClose)).toEqual([]);

    phase = 'transfer-countdown';
    await host.goto(social);
    await startPlayingRoom();
    await a.getByRole('button', { name: 'Transfer and leave', exact: true }).click();
    await expect(b.getByText(/^The host offered you the host role\. If you accept, the current host leaves the room\./)).toBeVisible();
    await expect(b.getByRole('timer')).toHaveText(/^This offer expires in 0:[0-3]\d\.$/);
    await expect(a.getByRole('timer')).toHaveText(/^This offer expires in 0:[0-3]\d\.$/);
    await a.getByRole('button', { name: 'Cancel transfer', exact: true }).click();
    await expect(b.getByRole('timer')).toHaveCount(0);
    await expect(b.getByRole('button', { name: 'Accept host role', exact: true })).toHaveCount(0);
    expect(hostState()!.hostMemberId).toBe(hostState()!.self.memberId);

    phase = 'observer-logout';
    const guestObserver = await newPage();
    await signIn(guestObserver, 'invitation_guest', baseURL!);
    await expect(roomPanel(guestObserver).getByRole('button', { name: 'Use this device', exact: true })).toBeVisible();
    await guestObserver.goto(new URL('/finitude/account', baseURL).href);
    await guestObserver.getByRole('button', { name: 'Log out', exact: true }).click();
    await expect(guestObserver).toHaveURL(/\/finitude\/?$/);
    // Revoking an observer session cannot remove the playing device's membership.
    await advancing(guest);
    expect(guestState()).toMatchObject({ self: { isController: true } });
    await expect.poll(() => hostState()?.members.map(member => member.connected)).toEqual([true, true]);

    phase = 'host-control-close';
    await host.goto('about:blank');
    await expect(b.getByRole('timer')).toHaveText(graceText);
    expect(guestState()!.controlMode).toBe('hostOnly');
    await ageHostAbsence(baseURL!, 300_000);
    await expect.poll(() => guestState()).toBeNull();
    await expect(b.getByRole('button', { name: 'Start a room', exact: true })).toBeVisible();
    await silent(guest);

    phase = 'logout-all';
    await host.goto(social);
    await startPlayingRoom();
    const hostObserver = await newPage();
    await signIn(hostObserver, 'invitation_host', baseURL!);
    await expect(roomPanel(hostObserver).getByRole('button', { name: 'Use this device', exact: true })).toBeVisible();
    await hostObserver.goto(new URL('/finitude/account', baseURL).href);
    await hostObserver.getByRole('button', { name: 'Sign out everywhere', exact: true }).click();
    await hostObserver.getByRole('button', { name: 'Confirm sign out everywhere', exact: true }).click();
    await expect(hostObserver).toHaveURL(/\/finitude\/?$/);
    // Sign out everywhere removes the host's participation and ends the hosted room for everyone.
    await expect.poll(() => guestState()).toBeNull();
    await expect(b.getByRole('button', { name: 'Start a room', exact: true })).toBeVisible();
    await silent(guest);
    // The host's still-open controller tab keeps no audio, and its revoked session shows neither the
    // room nor a signed-in account when the tab loads again.
    await silent(host);
    await host.reload();
    await expect(host.getByRole('link', { name: 'Log in', exact: true }).first()).toBeVisible();
    await expect(a.getByRole('button', { name: 'End room', exact: true })).toHaveCount(0);
  } finally {
    await testInfo.attach('room-lifecycle-state', { body: JSON.stringify({ phase, commands }), contentType: 'application/json' });
    await Promise.all(contexts.map(context => context.close()));
  }
});
