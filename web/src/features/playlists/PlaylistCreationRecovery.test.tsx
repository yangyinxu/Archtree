import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { advanceAccountEpoch } from '../../api/accountEpoch';
import { playlistQueryKeys, type PlaylistDetail } from '../../api/playlists';
import { PlaylistNameDialog } from './PlaylistDialogs';
import { playlistCreationSession } from './playlistCreationSession';

const result = (id: string, name: string): PlaylistDetail => ({ id, name, revision: 1, items: [], itemCount: 0,
  artworkUrl: '', createdAt: '2026-09-16T12:00:00.000Z', updatedAt: '2026-09-16T12:00:00.000Z' });
const response = (value: PlaylistDetail, viewerId = 'alice') => new Response(JSON.stringify(value), {
  status: 201, headers: { 'Content-Type': 'application/json', 'X-Finitude-Account-Viewer': viewerId }
});
const setup = () => {
  const client = new QueryClient();
  const confirmed = vi.fn();
  const mount = (viewerId = 'alice') => render(<QueryClientProvider client={client}>
    <PlaylistNameDialog mode="create" viewerId={viewerId} onClose={() => undefined} onConfirmed={confirmed} returnFocusRef={{ current: null }} />
  </QueryClientProvider>);
  return { client, confirmed, mount };
};
beforeEach(() => playlistCreationSession.reset());
afterEach(() => playlistCreationSession.reset());

test('committed creation with lost acknowledgement is recovered across remount with the same key, never duplicated', async () => {
  const user = userEvent.setup();
  const created = new Map<string, PlaylistDetail>();
  let loseAcknowledgement = true;
  const fetcher = vi.fn(async (_path: RequestInfo | URL, options?: RequestInit) => {
    const key = new Headers(options?.headers).get('Idempotency-Key')!;
    const { name } = JSON.parse(String(options?.body));
    if (!created.has(key)) created.set(key, result(`playlist-${created.size + 1}`, name));
    if (loseAcknowledgement) { loseAcknowledgement = false; throw new TypeError('Response lost after commit'); }
    return response(created.get(key)!);
  });
  vi.stubGlobal('fetch', fetcher);
  const { client, confirmed, mount } = setup();
  const first = mount();
  await user.type(screen.getByRole('textbox'), 'Quiet');
  await user.click(screen.getByRole('button', { name: 'Create Playlist' }));
  await screen.findByText(/Creation of “Quiet” is not confirmed/);
  expect(screen.getByRole('button', { name: 'Close' })).toBeEnabled();
  first.unmount();
  const second = mount();
  expect(screen.getByRole('textbox')).toHaveValue('Quiet');
  expect(screen.getByRole('textbox')).toHaveAttribute('readonly');
  expect(screen.queryByRole('button', { name: 'Create Playlist' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Retry this action' }));
  await waitFor(() => expect(confirmed).toHaveBeenCalledWith('playlist-1'));
  expect(confirmed).toHaveBeenCalledTimes(1);
  expect(created.size).toBe(1);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('Idempotency-Key'))
    .toBe(new Headers(fetcher.mock.calls[1][1]?.headers).get('Idempotency-Key'));
  expect(client.getQueryData(playlistQueryKeys.detail('alice', 'playlist-1'))).toEqual(result('playlist-1', 'Quiet'));
  second.unmount(); client.clear();
});

test('pending creation remains recoverable when route navigation unmounts the dialog', async () => {
  const user = userEvent.setup();
  let settle!: () => void;
  vi.stubGlobal('fetch', vi.fn().mockImplementation(() => new Promise<Response>(resolve => { settle = () => resolve(response(result('playlist-1', 'Quiet'))); })));
  const { client, confirmed, mount } = setup();
  const first = mount();
  await user.type(screen.getByRole('textbox'), 'Quiet');
  await user.click(screen.getByRole('button', { name: 'Create Playlist' }));
  first.unmount();
  await act(async () => { settle(); await vi.waitFor(() => expect(playlistCreationSession.getSnapshot().status).toBe('confirmed')); });
  expect(confirmed).not.toHaveBeenCalled();
  const second = mount();
  await waitFor(() => expect(confirmed).toHaveBeenCalledWith('playlist-1'));
  second.unmount(); client.clear();
});

test('a name may be reused after explicit abandonment, which warns that it cannot undo the original creation', async () => {
  const user = userEvent.setup();
  const fetcher = vi.fn().mockRejectedValueOnce(new TypeError('Lost acknowledgement'))
    .mockResolvedValueOnce(response(result('playlist-2', 'Quiet')));
  vi.stubGlobal('fetch', fetcher);
  const consent = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
  const { client, confirmed, mount } = setup();
  const dialog = mount();
  await user.type(screen.getByRole('textbox'), 'Quiet');
  await user.click(screen.getByRole('button', { name: 'Create Playlist' }));
  await user.click(await screen.findByRole('button', { name: 'Stop retrying' }));
  expect(screen.getByRole('button', { name: 'Retry this action' })).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Stop retrying' }));
  expect(consent).toHaveBeenLastCalledWith(expect.stringContaining('It may already exist. This does not delete it.'));
  expect(screen.getByRole('textbox')).toHaveValue('');
  expect(fetcher).toHaveBeenCalledTimes(1);
  await user.type(screen.getByRole('textbox'), 'Quiet');
  await user.click(screen.getByRole('button', { name: 'Create Playlist' }));
  await waitFor(() => expect(confirmed).toHaveBeenCalledWith('playlist-2'));
  expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('Idempotency-Key'))
    .not.toBe(new Headers(fetcher.mock.calls[1][1]?.headers).get('Idempotency-Key'));
  dialog.unmount(); client.clear();
});

test('same-name creation after confirmed success is a new explicit intent', async () => {
  const user = userEvent.setup();
  const fetcher = vi.fn().mockResolvedValueOnce(response(result('playlist-1', 'Quiet')))
    .mockResolvedValueOnce(response(result('playlist-2', 'Quiet')));
  vi.stubGlobal('fetch', fetcher);
  const { client, confirmed, mount } = setup();
  const first = mount();
  await user.type(screen.getByRole('textbox'), 'Quiet');
  await user.click(screen.getByRole('button', { name: 'Create Playlist' }));
  await waitFor(() => expect(confirmed).toHaveBeenCalledWith('playlist-1'));
  first.unmount();
  const second = mount();
  await user.type(screen.getByRole('textbox'), 'Quiet');
  await user.click(screen.getByRole('button', { name: 'Create Playlist' }));
  await waitFor(() => expect(confirmed).toHaveBeenCalledWith('playlist-2'));
  expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('Idempotency-Key'))
    .not.toBe(new Headers(fetcher.mock.calls[1][1]?.headers).get('Idempotency-Key'));
  second.unmount(); client.clear();
});

test('account transition clears recovery and a late old acknowledgement cannot navigate the replacement dialog', async () => {
  const user = userEvent.setup();
  let settle!: () => void;
  const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { settle = () => resolve(response(result('playlist-alice', 'Private name'))); }))
    .mockResolvedValueOnce(response(result('playlist-bob', 'New name'), 'bob'));
  vi.stubGlobal('fetch', fetcher);
  const { client, confirmed, mount } = setup();
  const first = mount();
  await user.type(screen.getByRole('textbox'), 'Private name');
  await user.click(screen.getByRole('button', { name: 'Create Playlist' }));
  act(() => advanceAccountEpoch());
  first.unmount();
  const second = mount('bob');
  expect(screen.getByRole('textbox')).toHaveValue('');
  await user.type(screen.getByRole('textbox'), 'New name');
  await user.click(screen.getByRole('button', { name: 'Create Playlist' }));
  await waitFor(() => expect(confirmed).toHaveBeenCalledWith('playlist-bob'));
  await act(async () => { settle(); await vi.dynamicImportSettled(); });
  expect(confirmed).toHaveBeenCalledTimes(1);
  expect(client.getQueryData(playlistQueryKeys.detail('alice', 'playlist-alice'))).toBeUndefined();
  second.unmount(); client.clear();
});

test('an unknown result arriving after route unmount still exposes its original recovery on remount', async () => {
  const user = userEvent.setup();
  let reject!: (error: unknown) => void;
  const fetcher = vi.fn().mockImplementation(() => new Promise<Response>((_resolve, no) => { reject = no; }));
  vi.stubGlobal('fetch', fetcher);
  const { client, mount } = setup();
  const first = mount();
  await user.type(screen.getByRole('textbox'), 'Quiet');
  await user.click(screen.getByRole('button', { name: 'Create Playlist' }));
  const intent = playlistCreationSession.getSnapshot().intent;
  first.unmount();
  reject(new TypeError('Connection ended after dispatch'));
  await vi.waitFor(() => expect(playlistCreationSession.getSnapshot().status).toBe('uncertain'));
  const second = mount();
  expect(screen.getByRole('textbox')).toHaveValue('Quiet');
  expect(screen.getByRole('button', { name: 'Retry this action' })).toBeInTheDocument();
  expect(playlistCreationSession.getSnapshot().intent).toBe(intent);
  second.unmount(); client.clear();
});

test('an expired create cannot dispatch again and explains manual reconciliation before another creation', async () => {
  const user = userEvent.setup();
  const fetcher = vi.fn().mockRejectedValue(new TypeError('Connection ended after dispatch'));
  vi.stubGlobal('fetch', fetcher);
  const { client, mount } = setup();
  const dialog = mount();
  await user.type(screen.getByRole('textbox'), 'Quiet');
  await user.click(screen.getByRole('button', { name: 'Create Playlist' }));
  await screen.findByRole('button', { name: 'Retry this action' });
  vi.spyOn(Date, 'now').mockReturnValue(playlistCreationSession.getSnapshot().intent!.expiresAt);
  await user.click(screen.getByRole('button', { name: 'Retry this action' }));
  expect(screen.getByText(/The retry window for “Quiet” has ended/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Retry this action' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Stop retrying' })).toBeInTheDocument();
  expect(fetcher).toHaveBeenCalledTimes(1);
  dialog.unmount(); client.clear();
});
