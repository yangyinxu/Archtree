import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import type { RoomSnapshot } from '../src/api/rooms';
import { expectNoUnownedAxeViolations } from '../e2e/support/accessibility';

const sharedCard = (page: Page, title: string) => page.getByRole('article', { name: title, exact: true });
const roomPanel = (page: Page) => page.getByRole('region', { name: 'Listening room', exact: true });
const player = (page: Page) => page.getByRole('region', { name: 'Now playing', exact: true });
const transport = (page: Page) => player(page).getByRole('group', { name: 'Playback controls', exact: true });

/** Observes authorized frames without replacing the realtime or media implementation. */
const observeRoom = (page: Page) => {
  let current: RoomSnapshot | null | undefined;
  page.on('websocket', socket => socket.on('framereceived', frame => {
    const message = JSON.parse(String(frame.payload));
    if (message.type === 'subscribed' || message.type === 'snapshot') current = message.room;
  }));
  return () => current;
};

const silent = async (page: Page) => {
  await expect.poll(() => page.locator('audio, video').evaluateAll(elements =>
    elements.every(element => (element as HTMLMediaElement).paused))).toBe(true);
};
const playing = async (page: Page, title: string) => {
  await expect(player(page)).toContainText(title);
  await expect.poll(() => page.locator('audio, video').evaluateAll(elements => elements.filter(element => {
    const media = element as HTMLMediaElement;
    return !media.paused && media.readyState >= 3 && media.currentTime > 0;
  }).length)).toBe(1);
};

const login = async (page: Page, name: string, baseURL: string) => {
  await page.goto(new URL('/finitude/login', baseURL).href);
  await page.getByLabel('Email or username').fill(`${name}@example.test`);
  await page.getByLabel('Password', { exact: true }).fill('Social-real-browser-2026!');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page).not.toHaveURL(/\/login(?:[?#]|$)/);
};

/** Records the actual share dialog/inbox at both widths, then restores the desktop viewport. */
const captureResponsive = async (page: Page, focus: Locator, name: string) => {
  const original = page.viewportSize()!;
  try {
    for (const [size, viewport] of [['desktop', original], ['320', { width: 320, height: 800 }]] as const) {
      await page.setViewportSize(viewport);
      await focus.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest' }));
      await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('html, body, main, header, [role="dialog"]')]
        .every(element => element.scrollWidth <= element.clientWidth + 1)),
      { message: `${name}: no horizontal overflow at ${size}` }).toBe(true);
      const path = test.info().outputPath(`${name}-${size}.png`);
      await page.screenshot({ path, fullPage: true, animations: 'disabled' });
      await test.info().attach(`${name}-${size}`, { path, contentType: 'image/png' });
      console.log(`Music share screenshot: ${path}`);
      if (size === '320') await expectNoUnownedAxeViolations(page, `${name}-${size}`);
    }
  } finally { await page.setViewportSize(original); }
};

const openShare = async (page: Page, title: string, baseURL: string) => {
  await page.goto(new URL(`/finitude/search?q=${encodeURIComponent(title)}`, baseURL).href);
  await page.getByRole('button', { name: `Share ${title}`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `Share ${title}`, exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('combobox', { name: 'Choose a friend', exact: true })
    .selectOption({ label: 'Invitation guest (@invitation_guest)' });
  return dialog;
};

const sendShare = async (page: Page, dialog: Locator, expected: 'applied' | 'noop') => {
  const response = page.waitForResponse(value => value.request().method() === 'POST'
    && new URL(value.url()).pathname === '/api/social/v1/music-shares');
  await dialog.getByRole('button', { name: 'Send share', exact: true }).click();
  const result = await response;
  expect(result.status()).toBe(200);
  expect(await result.json()).toMatchObject({ outcome: expected, replayed: false });
  await expect(dialog.getByText('Updated.', { exact: true })).toBeVisible();
};

const openInbox = async (page: Page, baseURL: string) => {
  await page.goto(new URL('/finitude/social/shares', baseURL).href);
  await expect(page.getByRole('heading', { level: 1, name: 'Music shares', exact: true })).toBeVisible();
};

const endRoom = async (page: Page) => {
  if (page.isClosed()) return;
  await page.getByRole('link', { name: 'Together', exact: true }).click();
  const end = roomPanel(page).getByRole('button', { name: 'End room', exact: true });
  await expect(end).toBeVisible();
  page.once('dialog', dialog => dialog.accept());
  await end.click();
  await expect(end).toHaveCount(0);
};

test('friends share tracks and albums for later explicit playback, saving and room invitations', async ({ browser, baseURL }) => {
  // Separate process/stores isolate production rate budgets; the configured Chromium sink never opens hardware audio.
  const contexts: BrowserContext[] = [];
  const failures: Array<{ path: string; status: number }> = [];
  const roomActions: string[] = [];
  const saveWrites: string[] = [];
  let recipient: Page | undefined;
  let createdRoom = false;
  try {
    for (let index = 0; index < 2; index += 1) {
      const context = await browser.newContext({ baseURL, reducedMotion: 'reduce' }); contexts.push(context);
      context.on('response', response => {
        const path = new URL(response.url()).pathname;
        if (path.startsWith('/api/social/') && response.status() >= 400) failures.push({ path, status: response.status() });
      });
      context.on('request', request => {
        const path = new URL(request.url()).pathname;
        if (request.method() === 'POST' && path === '/api/social/v1/room-commands') roomActions.push(request.postDataJSON().action);
        if (['PUT', 'DELETE'].includes(request.method()) && /^\/content\/me\/saves\/(?:audioTrack|album)\//.test(path)) saveWrites.push(path);
      });
    }
    const sender = await contexts[0].newPage();
    const senderRoom = observeRoom(sender);
    await login(sender, 'invitation_host', baseURL!);
    const trackDialog = await openShare(sender, 'First Light', baseURL!);
    await captureResponsive(sender, trackDialog, 'music-share-dialog');
    await sendShare(sender, trackDialog, 'applied');
    await sendShare(sender, trackDialog, 'noop');
    await sender.keyboard.press('Escape');
    await expect(trackDialog).toHaveCount(0);
    const albumDialog = await openShare(sender, 'Shared Horizons', baseURL!);
    await sendShare(sender, albumDialog, 'applied');
    await sender.keyboard.press('Escape');
    await captureResponsive(sender, sender.getByRole('button', { name: 'Share Shared Horizons', exact: true }), 'music-share-catalog');
    await openInbox(sender, baseURL!);
    await sender.getByRole('button', { name: 'Sent', exact: true }).click();
    for (const title of ['First Light', 'Shared Horizons']) {
      await expect(sharedCard(sender, title)).toHaveCount(1);
      await expect(sharedCard(sender, title).getByText('To Invitation guest', { exact: true })).toBeVisible();
    }
    await silent(sender);
    expect(saveWrites).toEqual([]);
    expect(roomActions).toEqual([]);

    // The recipient had no page or authenticated socket when either share was sent.
    recipient = await contexts[1].newPage();
    const recipientRoom = observeRoom(recipient);
    await login(recipient, 'invitation_guest', baseURL!);
    await openInbox(recipient, baseURL!);
    await expect(recipient.getByRole('button', { name: 'Received', exact: true })).toHaveAttribute('aria-pressed', 'true');
    for (const title of ['First Light', 'Shared Horizons']) {
      await expect(sharedCard(recipient, title)).toHaveCount(1);
      await expect(sharedCard(recipient, title).getByText('From Invitation host', { exact: true })).toBeVisible();
    }
    await expect(recipient.getByRole('button', { name: 'Invite to my room', exact: true })).toHaveCount(0);
    await captureResponsive(recipient, sharedCard(recipient, 'Shared Horizons'), 'music-share-inbox');
    await recipient.reload();
    for (const title of ['First Light', 'Shared Horizons']) await expect(sharedCard(recipient, title)).toHaveCount(1);
    await silent(recipient);
    await expect.poll(recipientRoom).toBeNull();
    expect(saveWrites).toEqual([]);
    expect(roomActions).toEqual([]);

    for (const title of ['First Light', 'Shared Horizons']) {
      await sharedCard(recipient, title).getByRole('button', { name: 'Save to Library', exact: true }).click();
      await expect(sharedCard(recipient, title).getByRole('button', { name: 'Remove from Library', exact: true })).toBeVisible();
    }
    await silent(recipient);
    expect(saveWrites).toHaveLength(2);
    await sharedCard(recipient, 'First Light').getByRole('button', { name: 'Play', exact: true }).click();
    await playing(recipient, 'First Light');
    await transport(recipient).getByRole('button', { name: 'Pause', exact: true }).click();
    await silent(recipient);
    await sharedCard(recipient, 'Shared Horizons').getByRole('button', { name: 'Play', exact: true }).click();
    await playing(recipient, 'First Light');
    // Every Album member is reached in canonical order using the real single-player queue.
    for (const title of ['Across the Water', 'Home Again']) {
      await transport(recipient).getByRole('button', { name: 'Next MediaTrack', exact: true }).click();
      await playing(recipient, title);
    }
    await expect(transport(recipient).getByRole('button', { name: 'Next MediaTrack', exact: true })).toBeDisabled();
    await transport(recipient).getByRole('button', { name: 'Pause', exact: true }).click();
    await silent(recipient);
    expect(roomActions).toEqual([]);

    await recipient.getByRole('link', { name: 'Together', exact: true }).click();
    await roomPanel(recipient).getByRole('checkbox', { name: /First Light/ }).check();
    await roomPanel(recipient).getByRole('button', { name: 'Start a room', exact: true }).click();
    createdRoom = true;
    await expect(roomPanel(recipient).getByRole('button', { name: 'End room', exact: true })).toBeVisible();
    const originalRoomId = recipientRoom()!.roomId;
    await recipient.getByRole('link', { name: 'Music shares', exact: true }).click();
    await sharedCard(recipient, 'First Light').getByRole('button', { name: 'Invite to my room', exact: true }).click();
    await expect(sender.getByRole('link', { name: 'Room invitations: pending invitation', exact: true }))
      .toHaveAttribute('data-has-pending', 'true');
    await expect.poll(senderRoom).toBeNull();
    expect(recipientRoom()?.roomId).toBe(originalRoomId);
    await expect(sharedCard(recipient, 'First Light').getByRole('button', { name: 'Play', exact: true })).toBeDisabled();
    await expect(recipient.getByText('Leave your current room in Together before playing this music on your own.')).toBeVisible();
    expect(recipientRoom()?.roomId).toBe(originalRoomId);
    await Promise.all([silent(sender), silent(recipient)]);
    expect(roomActions).toEqual(['create', 'invite']);

    await sharedCard(recipient, 'First Light').getByRole('button', { name: 'Dismiss share', exact: true }).click();
    await expect(sharedCard(recipient, 'First Light')).toHaveCount(0);
    await expect(sharedCard(sender, 'First Light')).toHaveCount(0);
    await sharedCard(sender, 'Shared Horizons').getByRole('button', { name: 'Withdraw share', exact: true }).click();
    await expect(sharedCard(sender, 'Shared Horizons')).toHaveCount(0);
    await expect(sharedCard(recipient, 'Shared Horizons')).toHaveCount(0);
    expect(saveWrites).toHaveLength(2);
    await endRoom(recipient); createdRoom = false;
    await expect.poll(recipientRoom).toBeNull();
    expect(failures).toEqual([]);
  } finally {
    if (failures.length) console.log(`Music share HTTP failures: ${JSON.stringify(failures)}`);
    try { if (createdRoom && recipient) await endRoom(recipient).catch(() => undefined); }
    finally { await Promise.all(contexts.map(context => context.close())); }
  }
});
