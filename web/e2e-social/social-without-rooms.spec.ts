import { expect, test, type BrowserContext, type Page } from '@playwright/test';

// The fixture runs FINITUDE_ROOMS_ENABLED=false without a realtime gateway, so nothing can arrive over a socket.
// A change-poll cycle backs off to one minute; the bound below leaves room for one full idle interval.
const arrival = { timeout: 75_000 };

const login = async (page: Page, name: string) => {
  await page.goto('/finitude/login');
  await page.getByLabel('Email or username').fill(`${name}@example.test`);
  await page.getByLabel('Password', { exact: true }).fill('Social-real-browser-2026!');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page).not.toHaveURL(/\/login(?:[?#]|$)/);
};

test('with rooms disabled, friend requests and music shares reach open pages without a socket or reload', async ({ browser, baseURL }) => {
  test.setTimeout(240_000);
  const contexts: BrowserContext[] = [];
  const failures: Array<{ path: string; status: number }> = [];
  const sockets: string[] = [];
  const recipientReads: string[] = [];
  try {
    for (let index = 0; index < 3; index += 1) {
      const context = await browser.newContext({ baseURL, reducedMotion: 'reduce' }); contexts.push(context);
      context.on('response', response => {
        const path = new URL(response.url()).pathname;
        if (path.startsWith('/api/social/') && response.status() >= 400) failures.push({ path, status: response.status() });
      });
    }
    const [recipient, requester, sharer] = await Promise.all(contexts.map(context => context.newPage()));
    recipient.on('websocket', socket => sockets.push(socket.url()));
    recipient.on('request', request => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith('/api/social/')) recipientReads.push(`${request.method()} ${path}`);
    });

    await login(recipient, 'invitation_host');
    await recipient.goto('/finitude/social');
    await recipient.getByRole('tab', { name: 'Incoming requests' }).click();
    await expect(recipient.getByText('Nothing here yet.', { exact: true })).toBeVisible();

    await login(requester, 'invitation_other');
    await requester.goto('/finitude/social');
    const lookup = requester.getByRole('form', { name: 'Find a friend' });
    await lookup.getByLabel('Handle', { exact: true }).fill('invitation_host');
    await lookup.getByRole('button', { name: 'Find', exact: true }).click();
    await requester.getByRole('button', { name: 'Add friend', exact: true }).click();
    await expect(requester.getByRole('button', { name: 'Add friend', exact: true })).toHaveCount(0);

    // The already-open Incoming tab shows the request without a reload, tab switch or socket.
    await expect(recipient.getByRole('button', { name: 'Accept', exact: true })).toBeVisible(arrival);
    await expect(recipient.getByText('Invitation other', { exact: true })).toBeVisible();

    // Client-side navigation keeps the account's change fallback; the received list starts empty.
    await recipient.getByRole('main').getByRole('link', { name: 'Music shares', exact: true }).click();
    await expect(recipient.getByRole('heading', { level: 1, name: 'Music shares', exact: true })).toBeVisible();
    await expect(recipient.getByText('No received music shares.', { exact: true })).toBeVisible();

    await login(sharer, 'invitation_guest');
    await sharer.goto('/finitude/search?q=First%20Light');
    await sharer.getByRole('button', { name: 'Share First Light', exact: true }).click();
    const dialog = sharer.getByRole('dialog', { name: 'Share First Light', exact: true });
    await dialog.getByRole('combobox', { name: 'Choose a friend', exact: true })
      .selectOption({ label: 'Invitation host (@invitation_host)' });
    await dialog.getByRole('button', { name: 'Send share', exact: true }).click();
    await expect(dialog.getByText('Updated.', { exact: true })).toBeVisible();

    const card = recipient.getByRole('article', { name: 'First Light', exact: true });
    await expect(card).toBeVisible(arrival);
    await expect(card.getByText('From Invitation guest', { exact: true })).toBeVisible();

    // Delivery came from the HTTP change cursor: the recipient opened no socket and requested no ticket.
    expect(sockets).toEqual([]);
    expect(recipientReads.some(value => value === 'POST /api/social/v1/realtime-tickets')).toBe(false);
    expect(recipientReads.filter(value => value === 'GET /api/social/v1/me/changes').length).toBeGreaterThan(0);
    expect(failures).toEqual([]);
  } finally {
    await Promise.all(contexts.map(context => context.close()));
  }
});
