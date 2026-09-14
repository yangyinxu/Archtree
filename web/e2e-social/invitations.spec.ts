import { expect, test, type Locator, type Page } from '@playwright/test';
import type { RoomSnapshot } from '../src/api/rooms';
import { expectNoUnownedAxeViolations } from '../e2e/support/accessibility';

const invitationHeader = (page: Page) => page.getByRole('link', { name: /^Room invitations(?:: pending invitation)?$/ });
const roomPanel = (page: Page) => page.getByRole('region', { name: 'Listening room' });
const silentPlayer = async (page: Page) => {
  await expect.poll(() => page.locator('video, audio').evaluateAll(elements =>
    elements.every(element => (element as HTMLMediaElement).paused))).toBe(true);
};

/** Captures actual invitation surfaces and checks narrow layout, then restores the caller's viewport. */
const captureResponsive = async (page: Page, name: string, focus?: Locator) => {
  const original = page.viewportSize()!;
  try {
    for (const [size, viewport] of [['desktop', original], ['320', { width: 320, height: 800 }]] as const) {
      await page.setViewportSize(viewport);
      if (focus) await focus.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest' }));
      await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('html, body, main, header')]
        .every(element => element.scrollWidth <= element.clientWidth + 1)),
      { message: `${name} has no horizontal overflow at ${size}` }).toBe(true);
      const path = test.info().outputPath(`${name}-${size}.png`);
      await page.screenshot({ path, fullPage: true, animations: 'disabled' });
      await test.info().attach(`${name}-${size}`, { path, contentType: 'image/png' });
      console.log(`Invitation screenshot: ${path}`);
    }
  } finally { await page.setViewportSize(original); }
};

/** Read-only protocol evidence distinguishes explicit acceptance from merely opening a link. */
const observeRoom = (page: Page) => {
  let current: RoomSnapshot | null | undefined;
  const actions: string[] = [];
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/social/v1/room-commands') {
      actions.push(request.postDataJSON().action);
    }
  });
  page.on('websocket', socket => socket.on('framereceived', frame => {
    const message = JSON.parse(String(frame.payload));
    if (message.type === 'subscribed' || message.type === 'snapshot') current = message.room;
  }));
  return { current: () => current, actions };
};

const submitLogin = async (page: Page, name: string) => {
  await page.getByLabel('Email or username').fill(`${name}@example.test`);
  await page.getByLabel('Password', { exact: true }).fill('Social-real-browser-2026!');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page).not.toHaveURL(/\/login(?:[?#]|$)/);
};

/** Existing profiles/friendships belong to this test's disjoint fixture accounts; login initially lands on Home. */
const loginHome = async (page: Page, name: string, baseURL: string) => {
  await page.goto(new URL('/finitude/login', baseURL).href);
  await submitLogin(page, name);
  await expect(page).toHaveURL(new RegExp(`^${baseURL}/finitude/?$`));
  await expect(invitationHeader(page)).toBeVisible();
};

const createRoom = async (page: Page, baseURL: string) => {
  await page.goto(new URL('/finitude/social', baseURL).href);
  const panel = roomPanel(page);
  await panel.getByRole('checkbox', { name: /First Light/ }).check();
  await panel.getByRole('button', { name: 'Start a room', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'End room', exact: true })).toBeVisible();
};

const copyGuestInvitation = async (page: Page) => {
  const friend = roomPanel(page).getByRole('listitem').filter({ has: page.getByText('Invitation guest', { exact: true }) });
  await friend.getByRole('button', { name: 'Invite', exact: true }).click();
  await friend.getByRole('button', { name: 'Copy invitation link', exact: true }).click();
  // The real readonly copy fallback exposes the exact URL; no clipboard or media API is mocked.
  const link = page.getByRole('textbox', { name: 'Invitation link', exact: true });
  await expect(link).toBeVisible();
  const value = await link.inputValue();
  expect(new URL(value).pathname).toMatch(/^\/finitude\/social\/invitations\/[A-Za-z0-9_-]+$/);
  expect(new URL(value).search).toBe('');
  return value;
};

/** Resolve this test's hosted rooms so their periodic authority checks cannot contend with the next test. */
const endHostedRoom = async (page: Page) => {
  if (page.isClosed()) return;
  const end = roomPanel(page).getByRole('button', { name: 'End room', exact: true });
  if (!await end.isVisible()) return;
  page.once('dialog', dialog => dialog.accept());
  await end.click();
  await expect(end).toHaveCount(0);
};

test('global invitations reach Home and recipient links preserve explicit login, joining and existing rooms', async ({ browser, baseURL }) => {
  // These contexts inherit the configured hardware-free Chromium process; no additional browser is launched.
  const contexts: Awaited<ReturnType<typeof browser.newContext>>[] = [];
  const hosts: Page[] = [];
  const failures: Array<{ path: string; status: number }> = [];
  let completed = false;
  const newPage = async () => {
    const context = await browser.newContext({ baseURL, reducedMotion: 'reduce' }); contexts.push(context);
    context.on('response', response => {
      const path = new URL(response.url()).pathname;
      if (path.startsWith('/api/social/') && response.status() >= 400) failures.push({ path, status: response.status() });
    });
    return context.newPage();
  };
  try {
    const host = await newPage(); const homeGuest = await newPage(); const other = await newPage();
    const hostRoom = observeRoom(host); const homeRoom = observeRoom(homeGuest); const otherRoom = observeRoom(other);
    // Password verification deliberately permits only two concurrent requests; fixture setup needs no login race.
    await loginHome(host, 'invitation_host', baseURL!);
    await loginHome(homeGuest, 'invitation_guest', baseURL!);
    await loginHome(other, 'invitation_other', baseURL!);
    await expect(invitationHeader(homeGuest)).not.toHaveAttribute('data-has-pending', 'true');
    await expect.poll(homeRoom.current).toBeNull();
    hosts.push(host);
    await createRoom(host, baseURL!);
    const invitation = await copyGuestInvitation(host);
    await expect(invitationHeader(homeGuest)).toHaveAttribute('data-has-pending', 'true', { timeout: 5000 });
    await expect(homeGuest).toHaveURL(new RegExp(`^${baseURL}/finitude/?$`));
    await expect.poll(homeRoom.current).toBeNull();
    expect(homeRoom.actions).toEqual([]);
    await silentPlayer(homeGuest);
    await captureResponsive(homeGuest, 'invitation-global-header');
    await captureResponsive(host, 'invitation-host-copy', host.getByRole('textbox', { name: 'Invitation link', exact: true }));

    await invitationHeader(homeGuest).click();
    await expect(homeGuest).toHaveURL(`${baseURL}/finitude/social/invitations`);
    await expect(homeGuest.getByText(/Invitation host/)).toBeVisible();
    await expect(invitationHeader(homeGuest)).toHaveAttribute('data-has-pending', 'true');
    expect(homeRoom.actions).toEqual([]);

    await other.goto(invitation);
    await expect(other.getByText('This invitation is unavailable. It may have expired or belong to another account.', { exact: true })).toBeVisible();
    await expect(other.getByRole('button', { name: 'Join room', exact: true })).toHaveCount(0);
    await expect(other.getByText('Invitation host', { exact: true })).toHaveCount(0);
    await expect.poll(otherRoom.current).toBeNull();
    expect(otherRoom.actions).toEqual([]);
    await silentPlayer(other);

    const joinedGuest = await newPage(); const joinedRoom = observeRoom(joinedGuest);
    await joinedGuest.goto(invitation);
    if (!new URL(joinedGuest.url()).pathname.endsWith('/login')) {
      await joinedGuest.getByRole('main').getByRole('link', { name: 'Log in', exact: true }).click();
    }
    await expect(joinedGuest).toHaveURL(/\/finitude\/login(?:[?#]|$)/);
    expect(joinedRoom.actions).toEqual([]);
    await submitLogin(joinedGuest, 'invitation_guest');
    await expect(joinedGuest).toHaveURL(invitation);
    const join = joinedGuest.getByRole('button', { name: 'Join room', exact: true });
    await expect(join).toBeEnabled();
    await expect(joinedGuest.getByText(/Invitation host/)).toBeVisible();
    await expect(joinedGuest.getByText('First Light', { exact: true })).toHaveCount(0);
    await expect.poll(joinedRoom.current).toBeNull();
    expect(joinedRoom.actions).toEqual([]);
    await silentPlayer(joinedGuest);
    await expectNoUnownedAxeViolations(joinedGuest, 'invitation-before-acceptance');
    await captureResponsive(joinedGuest, 'invitation-detail');

    await join.click();
    await expect.poll(() => joinedRoom.current()?.roomId).toBe(hostRoom.current()!.roomId);
    await expect.poll(() => joinedRoom.current()?.self.isController).toBe(true);
    expect(joinedRoom.actions).toEqual(['acceptInvitation']);
    await expect(invitationHeader(homeGuest)).not.toHaveAttribute('data-has-pending', 'true');
    await expect(invitationHeader(joinedGuest)).not.toHaveAttribute('data-has-pending', 'true');
    const originalRoomId = joinedRoom.current()!.roomId;

    hosts.push(other);
    await createRoom(other, baseURL!);
    const secondInvitation = await copyGuestInvitation(other);
    await expect(invitationHeader(joinedGuest)).toHaveAttribute('data-has-pending', 'true', { timeout: 5000 });
    const inspector = await joinedGuest.context().newPage(); const inspectedRoom = observeRoom(inspector);
    await inspector.goto(secondInvitation);
    await expect(inspector).toHaveURL(secondInvitation);
    await expect(inspector.getByRole('button', { name: 'Join room', exact: true })).toBeDisabled();
    await expect(inspector.getByText("You're already in a room. Leave or end it before joining another.")).toBeVisible();
    await expect.poll(() => inspectedRoom.current()?.roomId).toBe(originalRoomId);
    expect(inspectedRoom.current()?.self.isController).toBe(false);
    expect(inspectedRoom.actions).toEqual([]);
    expect(joinedRoom.current()?.roomId).toBe(originalRoomId);
    expect(joinedRoom.current()?.self.isController).toBe(true);
    expect(joinedRoom.actions).toEqual(['acceptInvitation']);
    await silentPlayer(joinedGuest);
    await silentPlayer(inspector);
    await inspector.getByRole('button', { name: 'Decline', exact: true }).click();
    await expect(invitationHeader(joinedGuest)).not.toHaveAttribute('data-has-pending', 'true');
    await expect(invitationHeader(homeGuest)).not.toHaveAttribute('data-has-pending', 'true');
    expect(joinedRoom.current()?.roomId).toBe(originalRoomId);
    expect(joinedRoom.actions).toEqual(['acceptInvitation']);
    expect(inspectedRoom.actions).toEqual(['declineInvitation']);
    for (const page of hosts) await endHostedRoom(page);
    await expect.poll(joinedRoom.current).toBeNull();
    expect(failures).toEqual([]);
    completed = true;
  } finally {
    if (failures.length) console.log(`Invitation HTTP failures: ${JSON.stringify(failures)}`);
    try {
      // A failed assertion still attempts ordinary authorized room cleanup before closing its contexts.
      const cleanup = await Promise.allSettled(hosts.map(endHostedRoom));
      if (completed) {
        for (const result of cleanup) if (result.status === 'rejected') throw result.reason;
      }
    } finally { await Promise.all(contexts.map(context => context.close())); }
  }
});
