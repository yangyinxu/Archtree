import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import type { RoomSnapshot } from '../src/api/rooms';
import { expectNoUnownedAxeViolations } from '../e2e/support/accessibility';

const panel = (page: Page) => page.getByRole('region', { name: 'Listening room', exact: true });
const player = (page: Page) => page.getByRole('region', { name: 'Now playing', exact: true });
const roomEntry = (page: Page) => page.getByRole('link', { name: /^Open room:/ });
const silent = async (page: Page) => expect.poll(() => page.locator('audio, video').evaluateAll(nodes =>
  nodes.every(node => (node as HTMLMediaElement).paused))).toBe(true);

/** Observe production frames without replacing any transport, commands or media responses. */
const observe = (page: Page) => {
  let room: RoomSnapshot | null = null;
  page.on('websocket', socket => socket.on('framereceived', frame => {
    const value = JSON.parse(String(frame.payload));
    if (value.type === 'snapshot' || value.type === 'subscribed') room = value.room;
  }));
  return () => room;
};
const login = async (page: Page, name: string) => {
  await page.goto('/finitude/login');
  await page.getByLabel('Email or username').fill(`${name}@example.test`);
  await page.getByLabel('Password', { exact: true }).fill('Social-real-browser-2026!');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page).not.toHaveURL(/\/login/);
};
const search = async (page: Page, query: string) => {
  const input = page.getByRole('searchbox', { name: 'Search room-ready songs', exact: true });
  await input.fill(query);
  await input.press('Enter');
};
const request = async (page: Page, title: string, surface: Locator = page.locator('main')) => {
  await surface.getByRole('button', { name: `Listen together: ${title}`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `Listen together: ${title}`, exact: true });
  await dialog.getByRole('button', { name: 'Request song', exact: true }).click();
  await expect(dialog.getByText('Requested. Waiting for the host.', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
};

/** Capture real narrow layouts and reject overflow/accessibility regressions before restoring desktop. */
const capture = async (page: Page, name: string) => {
  const original = page.viewportSize()!;
  await page.setViewportSize({ width: 320, height: 800 });
  await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('html, body, main, header, [role="dialog"]')]
    .every(node => node.scrollWidth <= node.clientWidth + 1))).toBe(true);
  const path = test.info().outputPath(`${name}-320.png`);
  await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  await test.info().attach(name, { path, contentType: 'image/png' });
  await expectNoUnownedAxeViolations(page, name);
  await page.setViewportSize(original);
};

test('catalog and current player lead to explicit paused rooms and confirmed requests across routes', async ({ browser, baseURL }) => {
  const contexts: BrowserContext[] = [];
  const commands: string[] = [], failures: string[] = [];
  try {
    for (let i = 0; i < 2; i++) {
      const context = await browser.newContext({ baseURL, reducedMotion: 'reduce' }); contexts.push(context);
      context.on('request', req => {
        if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/social/v1/room-commands') commands.push(req.postDataJSON().action);
      });
      context.on('response', res => {
        if (new URL(res.url()).pathname.startsWith('/api/social/') && res.status() >= 400) failures.push(`${res.status()} ${new URL(res.url()).pathname}`);
      });
    }
    const host = await contexts[0].newPage(), guest = await contexts[1].newPage();
    const hostRoom = observe(host), guestRoom = observe(guest);
    await login(host, 'invitation_host'); await login(guest, 'invitation_guest');
    await host.goto('/finitude/social');
    // The first page has 20 newer tracks. Older initial tracks are reachable via Load more.
    await expect(panel(host).getByRole('checkbox')).toHaveCount(20);
    await panel(host).getByRole('button', { name: 'Load more', exact: true }).click();
    await expect(panel(host).getByRole('checkbox')).toHaveCount(25);
    await panel(host).getByRole('checkbox', { name: /^Home Again/ }).check();
    await search(host, 'First Light');
    await expect(panel(host).getByRole('checkbox')).toHaveCount(1);
    await expect(panel(host).getByRole('list', { name: 'Selected songs (1)' })).toContainText('Home Again');
    await search(host, 'no matching song');
    await expect(panel(host).getByText('No room-ready songs matched “no matching song”.')).toBeVisible();
    await expect(panel(host).getByRole('button', { name: 'Start a room', exact: true })).toBeEnabled();
    expect(commands).toEqual([]);

    await host.goto('/finitude/search?q=First%20Light');
    await host.locator('main').getByRole('button', { name: /^Play First Light/ }).click();
    await expect(player(host).getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
    await player(host).getByRole('button', { name: 'Pause', exact: true }).click();
    await player(host).getByRole('button', { name: 'Listen together: First Light', exact: true }).click();
    const composer = host.getByRole('dialog', { name: 'Listen together: First Light', exact: true });
    await composer.getByRole('combobox', { name: 'Choose a friend', exact: true }).selectOption({ label: 'Invitation guest (@invitation_guest)' });
    await capture(host, 'catalog-room-create');
    expect(commands).toEqual([]);
    await composer.getByRole('button', { name: 'Create paused room and invite', exact: true }).click();
    await expect(composer.getByText('Invitation sent. Open Together when you are ready to start listening.')).toBeVisible();
    await expect.poll(() => hostRoom()?.timeline?.state).toBe('paused');
    await silent(host);
    await composer.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(roomEntry(host)).toBeVisible();
    expect(commands).toEqual(['create', 'invite']);

    await guest.getByRole('link', { name: 'Room invitations: pending invitation', exact: true }).click();
    await guest.getByRole('button', { name: 'Join room', exact: true }).click();
    await expect.poll(() => guestRoom()?.members.length).toBe(2);
    await guest.goto('/finitude/search?q=Across%20the%20Water');
    await request(guest, 'Across the Water');
    await roomEntry(host).click();
    const pending = panel(host).getByRole('list', { name: 'Song requests', exact: true }).getByRole('listitem').filter({ hasText: 'Across the Water' });
    await expect(pending).toContainText('Requested by Invitation guest');
    await pending.getByRole('button', { name: 'Add to queue', exact: true }).click();
    await expect.poll(() => guestRoom()?.queue.map(entry => entry.title)).toEqual(['First Light', 'Across the Water']);

    await guest.goto('/finitude/search?q=Shared%20Horizons');
    await guest.locator('main').getByRole('link', { name: /Shared Horizons/ }).click();
    const albumRow = guest.getByRole('listitem').filter({ has: guest.getByRole('button', { name: 'Listen together: Home Again', exact: true }) });
    await albumRow.getByRole('button', { name: 'Save to Library', exact: true }).click();
    await request(guest, 'Home Again');
    await capture(guest, 'catalog-room-album');
    await guest.goto('/finitude/library');
    await guest.locator('main').getByRole('button', { name: 'Listen together: Home Again', exact: true }).click();
    const duplicate = guest.getByRole('dialog', { name: 'Listen together: Home Again', exact: true });
    await expect(duplicate.getByText('Requested. Waiting for the host.')).toBeVisible();
    await expect(duplicate.getByRole('button', { name: 'Request song', exact: true })).toBeDisabled();
    await duplicate.getByRole('button', { name: 'Close', exact: true }).click();
    await capture(guest, 'catalog-room-library');
    await Promise.all([silent(host), silent(guest)]);
    expect(commands.filter(command => command === 'requestSong')).toHaveLength(2);
    expect(commands.filter(command => ['play', 'pause', 'seek', 'takeControl', 'next', 'select'].includes(command))).toEqual([]);
    expect(failures).toEqual([]);
    host.once('dialog', dialog => dialog.accept());
    await panel(host).getByRole('button', { name: 'End room', exact: true }).click();
    await expect(roomEntry(host)).toHaveCount(0);
    await expect(roomEntry(guest)).toHaveCount(0);
  } finally { await Promise.all(contexts.map(context => context.close())); }
});
