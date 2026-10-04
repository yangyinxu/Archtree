import { expect, test, type BrowserContext, type Dialog, type Locator, type Page, type Response } from '@playwright/test';
import type { RoomSnapshot } from '../src/api/rooms';

// Each test owns its fixture process (see playwright.social.config.ts). The fixture provisions three profiles:
// Invitation host and Invitation other are each friends with Invitation guest, and not with each other.
const roomPanel = (page: Page) => page.getByRole('region', { name: 'Listening room', exact: true });
const relationships = (page: Page) => page.locator('section').filter({ has: page.getByRole('tablist', { name: 'Friends', exact: true }) });
const lookup = (page: Page) => page.locator('section').filter({ has: page.getByRole('form', { name: 'Find a friend', exact: true }) });
const listed = (page: Page, text: string) => relationships(page).getByRole('listitem').filter({ hasText: text });
const emptyList = (page: Page) => relationships(page).getByText('Nothing here yet.', { exact: true });
const showTab = (page: Page, name: string) => relationships(page).getByRole('tab', { name, exact: true }).click();
/** Re-reads the account's social state now instead of waiting for a live change notice. */
const refresh = (page: Page) => page.getByRole('main').getByRole('button', { name: 'Refresh', exact: true }).first().click();
const roomCommand = /^\/api\/social\/v1\/room-commands$/;
const isRoomCommand = (response: Response) => response.request().method() === 'POST' && roomCommand.test(new URL(response.url()).pathname);

const signIn = async (page: Page, username: string, baseURL: string) => {
  await page.goto(new URL('/finitude/login', baseURL).href);
  await page.getByLabel('Email or username').fill(`${username}@example.test`);
  await page.getByLabel('Password', { exact: true }).fill('Social-real-browser-2026!');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page).not.toHaveURL(/\/login(?:[?#]|$)/);
  await page.goto(new URL('/finitude/social', baseURL).href);
  await expect(roomPanel(page)).toBeVisible();
};
const findHandle = async (page: Page, handle: string) => {
  const form = page.getByRole('form', { name: 'Find a friend', exact: true });
  await form.getByLabel('Handle', { exact: true }).fill(handle);
  await form.getByRole('button', { name: 'Find', exact: true }).click();
};

/**
 * Clicks a social or room action, accepts its confirmation if one is asked (the browser's own confirm, or an
 * in-page dialog whose confirming button repeats the action's name), and requires the real server to apply it.
 * Whether an action must ask first has its own tests; these flows verify what the confirmed action changes.
 */
const perform = async (page: Page, trigger: Locator, path: RegExp) => {
  await expect(trigger).toBeEnabled({ timeout: 20_000 });
  const name = (await trigger.textContent())!.trim();
  const accept = (dialog: Dialog) => { void dialog.accept(); };
  page.on('dialog', accept);
  try {
    const sent = page.waitForResponse(response => response.request().method() !== 'GET' && path.test(new URL(response.url()).pathname));
    await trigger.click();
    const confirmation = page.getByRole('dialog');
    // A confirmed action cannot reach the server before its dialog is answered, so this race is deterministic.
    if (await Promise.race([sent.then(() => false), confirmation.waitFor().then(() => true, () => false)])) {
      await confirmation.getByRole('button', { name, exact: true }).click();
    }
    const response = await sent;
    expect(response.status(), `${name} reaches the server`).toBe(200);
    expect((await response.json()).outcome, `${name} is applied`).toBe('applied');
  } finally { page.off('dialog', accept); }
};

/** Reads actual server frames; no socket, command or snapshot is replaced. */
const observeRoom = (page: Page) => {
  let current: RoomSnapshot | null = null;
  page.on('websocket', socket => socket.on('framereceived', frame => {
    const message = JSON.parse(String(frame.payload));
    if (message.type === 'subscribed' || message.type === 'snapshot') current = message.room;
  }));
  return () => current;
};
/** Keeps the page's realtime sockets reachable, so the test can drop the transport the way a lost network does. */
const trackSockets = (page: Page) => page.addInitScript(() => {
  const sockets: WebSocket[] = [];
  Object.defineProperty(window, '__roomSockets', { value: sockets });
  window.WebSocket = new Proxy(WebSocket, { construct(target, argumentsList) {
    const socket: WebSocket = Reflect.construct(target, argumentsList);
    sockets.push(socket);
    return socket;
  } });
});
const dropSockets = (page: Page) => page.evaluate(() => {
  for (const socket of (window as unknown as { __roomSockets: WebSocket[] }).__roomSockets) socket.close();
});

test('friend requests, removal, blocking and deactivation change only what the social rules allow', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(180_000);
  const contexts: BrowserContext[] = [];
  let phase = 'setup';
  const mutations: string[] = [];
  try {
    for (let index = 0; index < 3; index += 1) contexts.push(await browser.newContext({ baseURL, reducedMotion: 'reduce' }));
    const [host, guest, other] = await Promise.all(contexts.map(context => context.newPage()));
    for (const [name, page] of [['host', host], ['guest', guest], ['other', other]] as const) page.on('response', response => {
      const path = new URL(response.url()).pathname;
      if (response.request().method() !== 'GET' && /^\/api\/social\/v1\/(?:relationships\/s_|friend-requests$|me\/(?:profile|deactivate)$)/.test(path)) {
        mutations.push(`${name}:${path.split('/').pop()}:${response.status()}`);
      }
    });
    await signIn(host, 'invitation_host', baseURL!);
    await signIn(guest, 'invitation_guest', baseURL!);
    await signIn(other, 'invitation_other', baseURL!);

    phase = 'cancel';
    await showTab(host, 'Incoming requests');
    await expect(emptyList(host)).toBeVisible();
    await findHandle(other, 'invitation_host');
    await perform(other, lookup(other).getByRole('button', { name: 'Add friend', exact: true }), /\/friend-requests$/);
    await refresh(host);
    await expect(listed(host, 'Invitation other')).toBeVisible();
    await showTab(other, 'Sent requests');
    await perform(other, listed(other, 'Invitation host').getByRole('button', { name: 'Cancel request', exact: true }), /\/cancel$/);
    await expect(emptyList(other)).toBeVisible();
    await expect(lookup(other).getByRole('button', { name: 'Add friend', exact: true })).toBeVisible();
    // The recipient loses the cancelled request.
    await refresh(host);
    await expect(emptyList(host)).toBeVisible();

    phase = 'decline';
    await perform(other, lookup(other).getByRole('button', { name: 'Add friend', exact: true }), /\/friend-requests$/);
    await refresh(host);
    await perform(host, listed(host, 'Invitation other').getByRole('button', { name: 'Decline', exact: true }), /\/decline$/);
    await expect(emptyList(host)).toBeVisible();
    await refresh(other);
    await expect(emptyList(other)).toBeVisible();
    // Declining is not blocking: the requester still finds the recipient and may ask again later.
    await expect(lookup(other).getByRole('button', { name: 'Add friend', exact: true })).toBeVisible();

    phase = 'remove';
    await showTab(other, 'Friends');
    await perform(other, listed(other, 'Invitation guest').getByRole('button', { name: 'Remove friend', exact: true }), /\/remove$/);
    await expect(emptyList(other)).toBeVisible();
    await refresh(guest);
    await expect(listed(guest, 'Invitation host')).toBeVisible();
    await expect(listed(guest, 'Invitation other')).toHaveCount(0);

    phase = 'block';
    await perform(guest, listed(guest, 'Invitation host').getByRole('button', { name: 'Block', exact: true }), /\/block$/);
    await expect(emptyList(guest)).toBeVisible();
    await showTab(guest, 'Blocked');
    const blocked = listed(guest, 'Blocked profile');
    await expect(blocked).toBeVisible();
    // The private block list holds only the opaque identity, never the blocked person's current profile.
    await expect(blocked).not.toContainText('Invitation host');
    await expect(blocked).not.toContainText('@invitation_host');
    await expect(blocked.getByRole('button', { name: 'Block', exact: true })).toHaveCount(0);
    await showTab(host, 'Friends');
    await refresh(host);
    await expect(emptyList(host)).toBeVisible();
    await findHandle(host, 'invitation_guest');
    // Being blocked looks exactly like a missing or undiscoverable handle.
    await expect(lookup(host).getByText('No discoverable profile found.', { exact: true })).toBeVisible();

    phase = 'unblock';
    await perform(guest, blocked.getByRole('button', { name: 'Unblock', exact: true }), /\/unblock$/);
    await expect(emptyList(guest)).toBeVisible();
    // Unblocking restores no relationship.
    await showTab(guest, 'Friends');
    await expect(emptyList(guest)).toBeVisible();
    await refresh(host);
    await expect(lookup(host).getByText('@invitation_guest', { exact: true })).toBeVisible();
    await expect(lookup(host).getByRole('button', { name: 'Add friend', exact: true })).toBeVisible();
    await expect(emptyList(host)).toBeVisible();

    phase = 'deactivate';
    // A fresh request and acceptance give the guest a friendship for deactivation to remove.
    await perform(host, lookup(host).getByRole('button', { name: 'Add friend', exact: true }), /\/friend-requests$/);
    await showTab(guest, 'Incoming requests');
    await refresh(guest);
    await perform(guest, listed(guest, 'Invitation host').getByRole('button', { name: 'Accept', exact: true }), /\/accept$/);
    await showTab(guest, 'Friends');
    await expect(listed(guest, 'Invitation host')).toBeVisible();
    await refresh(host);
    await expect(listed(host, 'Invitation guest')).toBeVisible();
    await perform(guest, guest.getByRole('button', { name: 'Deactivate social profile', exact: true }), /\/me\/deactivate$/);
    await expect(guest.getByText('Your social profile is inactive.', { exact: true })).toBeVisible();
    await expect(guest.getByRole('button', { name: 'Reactivate profile', exact: true })).toBeVisible();
    await expect(guest.getByRole('button', { name: 'Deactivate social profile', exact: true })).toHaveCount(0);
    // An inactive identity has no room surface and cannot look anyone up.
    await expect(roomPanel(guest)).toHaveCount(0);
    await expect(lookup(guest).getByLabel('Handle', { exact: true })).toBeDisabled();
    await expect(emptyList(guest)).toBeVisible();
    await refresh(host);
    await expect(emptyList(host)).toBeVisible();
    await expect(lookup(host).getByText('No discoverable profile found.', { exact: true })).toBeVisible();

    phase = 'reactivate';
    const identity = guest.getByRole('form', { name: 'Your social profile', exact: true });
    const discoverable = identity.getByRole('checkbox', { name: 'Let others find me by my exact handle', exact: true });
    // Deactivation turned discovery off; becoming findable again is an explicit choice.
    await expect(discoverable).not.toBeChecked();
    await discoverable.check();
    await perform(guest, identity.getByRole('button', { name: 'Reactivate profile', exact: true }), /\/me\/profile$/);
    await expect(identity.getByRole('button', { name: 'Save profile', exact: true })).toBeVisible();
    await expect(guest.getByText('Your social profile is inactive.', { exact: true })).toHaveCount(0);
    await expect(roomPanel(guest)).toBeVisible();
    // Reactivation restores none of the relationships that deactivation removed.
    await expect(emptyList(guest)).toBeVisible();
    await refresh(host);
    await expect(lookup(host).getByRole('button', { name: 'Add friend', exact: true })).toBeVisible();
    await expect(emptyList(host)).toBeVisible();

    // Every change came from one explicit action; none was resent or added along the way.
    expect(mutations).toEqual(['other:friend-requests:200', 'other:cancel:200', 'other:friend-requests:200', 'host:decline:200',
      'other:remove:200', 'guest:block:200', 'guest:unblock:200', 'host:friend-requests:200', 'guest:accept:200',
      'guest:deactivate:200', 'guest:profile:200']);
  } finally {
    await testInfo.attach('social-safety-state', { body: JSON.stringify({ phase, mutations }), contentType: 'application/json' });
    await Promise.all(contexts.map(context => context.close()));
  }
});

test('room members are removed, leave, reconnect and leave on a block, with only the commands they chose', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(180_000);
  const contexts: BrowserContext[] = [];
  let phase = 'setup';
  const commands: string[] = [];
  try {
    for (let index = 0; index < 2; index += 1) contexts.push(await browser.newContext({ baseURL, reducedMotion: 'reduce' }));
    const [host, guest] = await Promise.all(contexts.map(context => context.newPage()));
    await trackSockets(guest);
    const hostState = observeRoom(host);
    for (const [name, page] of [['host', host], ['guest', guest]] as const) page.on('request', request => {
      if (request.method() === 'POST' && roomCommand.test(new URL(request.url()).pathname)) commands.push(`${name}:${request.postDataJSON().action}`);
    });
    const a = roomPanel(host); const b = roomPanel(guest);
    const aliases = () => hostState()?.members.map(member => member.alias);
    await signIn(host, 'invitation_host', baseURL!);
    await signIn(guest, 'invitation_guest', baseURL!);
    /** The host invites its only friend, who joins by explicit action. */
    const admitGuest = async () => {
      await perform(host, a.getByRole('button', { name: 'Invite', exact: true }), roomCommand);
      await perform(guest, b.getByRole('button', { name: 'Join room', exact: true }), roomCommand);
      await expect.poll(aliases).toEqual(['Invitation host', 'Invitation guest']);
      await expect(b.getByRole('button', { name: 'Leave room', exact: true })).toBeVisible();
    };
    const guestOutside = async () => {
      await expect(b.getByRole('button', { name: 'Start a room', exact: true })).toBeVisible();
      await expect(b.getByRole('button', { name: 'Leave room', exact: true })).toHaveCount(0);
      await expect.poll(aliases).toEqual(['Invitation host']);
      // The host's room stays open without the guest.
      await expect(a.getByRole('button', { name: 'End room', exact: true })).toBeVisible();
    };

    phase = 'create';
    await a.getByRole('checkbox', { name: /First Light/ }).check();
    await perform(host, a.getByRole('button', { name: 'Start a room', exact: true }), roomCommand);
    await admitGuest();

    phase = 'remove-member';
    await perform(host, a.getByRole('button', { name: 'Remove from room', exact: true }), roomCommand);
    await guestOutside();
    // A removed member is still a friend and can be invited again.
    await admitGuest();

    phase = 'leave';
    const left = guest.waitForResponse(isRoomCommand);
    // With no dialog handler Playwright dismisses any confirmation, which would send nothing: leaving must not ask.
    await b.getByRole('button', { name: 'Leave room', exact: true }).click();
    expect(await (await left).json()).toMatchObject({ outcome: 'applied' });
    await guestOutside();
    await admitGuest();

    phase = 'reconnect';
    // Failing ticket requests keep the browser's own retries from restoring the transport before Reconnect.
    await guest.route('**/api/social/v1/realtime-tickets', route => route.abort());
    await dropSockets(guest);
    const lost = b.getByRole('status').filter({ hasText: 'Connection lost.' });
    await expect(lost).toBeVisible();
    await expect(b.getByText('Connecting…', { exact: true })).toBeVisible();
    // The membership survives the lost transport, and leaving needs no connection.
    await expect(b.getByRole('button', { name: 'Leave room', exact: true })).toBeEnabled();
    await guest.unroute('**/api/social/v1/realtime-tickets');
    await lost.getByRole('button', { name: 'Reconnect', exact: true }).click();
    await expect(b.getByText('Connected', { exact: true })).toBeVisible();
    await expect(lost).toHaveCount(0);
    await expect.poll(() => hostState()?.members.find(member => member.alias === 'Invitation guest')?.connected).toBe(true);

    phase = 'block-in-room';
    await perform(guest, listed(guest, 'Invitation host').getByRole('button', { name: 'Block', exact: true }), /\/block$/);
    // A blocked pair cannot share a room: the blocking guest leaves it and the host keeps it.
    await guestOutside();
    // The block also ended the friendship, so the host has nobody left to invite.
    await refresh(host);
    await expect(a.getByRole('button', { name: 'Invite', exact: true })).toHaveCount(0);

    // Reconnecting and blocking sent no room command; every other change is one the listener chose.
    expect(commands).toEqual(['host:create', 'host:invite', 'guest:acceptInvitation', 'host:kick', 'host:invite',
      'guest:acceptInvitation', 'guest:leave', 'host:invite', 'guest:acceptInvitation']);
  } finally {
    await testInfo.attach('room-membership-state', { body: JSON.stringify({ phase, commands }), contentType: 'application/json' });
    await Promise.all(contexts.map(context => context.close()));
  }
});
