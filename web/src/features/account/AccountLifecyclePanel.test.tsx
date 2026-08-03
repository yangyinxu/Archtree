import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';

import { browserSessionQueryKey } from '../../api/session';
import { readSearchHistory, rememberSearchQuery } from '../search/searchHistory';
import { AccountLifecyclePanel } from './AccountLifecyclePanel';

const viewerId = 'listener-1';

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' }
});

const renderPanel = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(browserSessionQueryKey, { user: { id: viewerId } });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/account']}>
        <Routes>
          <Route path="/account" element={<AccountLifecyclePanel viewerId={viewerId} />} />
          <Route path="/" element={<p>Public listener</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
  return { queryClient, ...result };
};

test('confirms and clears listening history without touching saved data or search history', async () => {
  const user = userEvent.setup();
  let finishRequest!: (response: Response) => void;
  const request = new Promise<Response>((resolve) => { finishRequest = resolve; });
  const fetchMock = vi.fn().mockReturnValue(request);
  vi.stubGlobal('fetch', fetchMock);
  const { queryClient } = renderPanel();
  queryClient.setQueryData(['listener', 'library', viewerId], { saved: ['album-1'] });
  rememberSearchQuery(viewerId, 'Still Water');

  const trigger = screen.getByRole('button', { name: 'Clear listening history' });
  await user.click(trigger);
  const dialog = screen.getByRole('dialog', { name: 'Clear listening history?' });
  expect(dialog).toHaveAttribute('aria-modal', 'true');
  expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();

  await user.click(screen.getByRole('button', { name: 'Clear history' }));
  expect(screen.getByRole('button', { name: 'Clearing…' })).toBeDisabled();
  fireEvent.keyDown(dialog, { key: 'Tab' });
  expect(dialog).toHaveFocus();
  finishRequest(new Response(null, { status: 204 }));

  expect(await screen.findByRole('status')).toHaveTextContent(
    'Listening history cleared. Your saved Library was not changed.'
  );
  expect(queryClient.getQueryData(['listener', 'library', viewerId])).toEqual({ saved: ['album-1'] });
  expect(readSearchHistory(viewerId)).toEqual(['Still Water']);
  expect(fetch).toHaveBeenCalledWith('/auth/activity/listening-history', expect.objectContaining({
    credentials: 'same-origin',
    method: 'DELETE'
  }));
  expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get(
    'X-Finitude-Account-Viewer'
  )).toBe(viewerId);
});

test('Escape cancels a confirmation and returns focus to its trigger', async () => {
  const user = userEvent.setup();
  renderPanel();
  const trigger = screen.getByRole('button', { name: 'Delete account' });

  await user.click(trigger);
  await user.keyboard('{Escape}');

  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  await waitFor(() => expect(trigger).toHaveFocus());
});

test('closes a stale confirmation as soon as the displayed account changes', async () => {
  const user = userEvent.setup();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const panel = (activeViewer: string) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AccountLifecyclePanel viewerId={activeViewer} />
      </MemoryRouter>
    </QueryClientProvider>
  );
  const view = render(panel('listener-1'));

  await user.click(screen.getByRole('button', { name: 'Delete account' }));
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  view.rerender(panel('listener-2'));

  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});

test('signs out every session, clears account state, and then clears browser cookies', async () => {
  const user = userEvent.setup();
  const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetchMock);
  const { queryClient } = renderPanel();
  queryClient.setQueryData(['account', viewerId, 'private'], { secret: true });
  rememberSearchQuery(viewerId, 'Night Drive');

  await user.click(screen.getByRole('button', { name: 'Sign out everywhere' }));
  await user.click(screen.getByRole('button', { name: 'Confirm sign out everywhere' }));

  expect(await screen.findByText('Public listener')).toBeInTheDocument();
  expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
    '/auth/logout-all',
    '/auth/browser/logout'
  ]);
  expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get(
    'X-Finitude-Account-Viewer'
  )).toBe(viewerId);
  expect(new Headers(fetchMock.mock.calls[1][1]?.headers).get(
    'X-Finitude-Account-Viewer'
  )).toBe(viewerId);
  expect(queryClient.getQueryData(['account', viewerId, 'private'])).toBeUndefined();
  expect(queryClient.getQueryData(browserSessionQueryKey)).toBeNull();
  expect(readSearchHistory(viewerId)).toEqual([]);
});

test('requires explicit avatar removal before account deletion', async () => {
  const user = userEvent.setup();
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
    message: 'The profile avatar must finish deleting before the account can be removed.',
    requiresAvatarDeletion: true
  }, 409));
  vi.stubGlobal('fetch', fetchMock);
  renderPanel();

  await user.click(screen.getByRole('button', { name: 'Delete account' }));
  await user.click(screen.getByRole('button', { name: 'Delete account permanently' }));

  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Remove your profile photo first, then return here to delete your account.'
  );
  expect(screen.getByRole('dialog', { name: 'Permanently delete your account?' })).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('preserves the safe creator-owned conflict returned by account deletion', async () => {
  const user = userEvent.setup();
  const message = 'Creator-owned content must be transferred or deleted before this account can be removed.';
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ message }, 409)));
  renderPanel();

  await user.click(screen.getByRole('button', { name: 'Delete account' }));
  await user.click(screen.getByRole('button', { name: 'Delete account permanently' }));

  expect(await screen.findByRole('alert')).toHaveTextContent(message);
});

test('deletes the account before clearing cookies and local account state', async () => {
  const user = userEvent.setup();
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockRejectedValueOnce(new TypeError('cookie cleanup connection dropped'));
  vi.stubGlobal('fetch', fetchMock);
  const { queryClient } = renderPanel();
  queryClient.setQueryData(['listener', 'library', viewerId], { private: true });
  rememberSearchQuery(viewerId, 'Delete Me');

  await user.click(screen.getByRole('button', { name: 'Delete account' }));
  await user.click(screen.getByRole('button', { name: 'Delete account permanently' }));

  expect(await screen.findByText('Public listener')).toBeInTheDocument();
  expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
    '/auth/account',
    '/auth/browser/logout'
  ]);
  expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get(
    'X-Finitude-Account-Viewer'
  )).toBe(viewerId);
  expect(queryClient.getQueryData(['listener', 'library', viewerId])).toBeUndefined();
  expect(queryClient.getQueryData(browserSessionQueryKey)).toBeNull();
  expect(readSearchHistory(viewerId)).toEqual([]);
});
