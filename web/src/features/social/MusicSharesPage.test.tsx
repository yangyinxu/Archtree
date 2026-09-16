import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { browserSessionQueryKey, browserSessionResolvingQueryKey } from '../../api/session';
import { advanceAccountEpoch } from '../../api/accountEpoch';
import type { MusicShareItem } from '../../api/musicShares';
import type { RoomSnapshot } from '../../api/rooms';
import type { AudioTrackSummary } from '../../api/contentSchemas';
import { roomFixture } from '../../test/roomFixture';
import { MusicSharesPage } from './MusicSharesPage';
import { musicShareSession } from './musicShareSession';

const mocks = vi.hoisted(() => ({ profile: vi.fn(), shares: vi.fn(), prepare: vi.fn(), send: vi.fn(), outcome: vi.fn(),
  track: vi.fn(), album: vi.fn(), statuses: vi.fn(), save: vi.fn(), launchTrack: vi.fn(), launchAlbum: vi.fn(), roomRun: vi.fn(), currentRoom: vi.fn(), refreshRoom: vi.fn(),
  roomState: { viewerId: 'viewer-1', room: null as RoomSnapshot | null, connected: true, busy: false, uncertain: null, error: null } }));
vi.mock('../../api/socialProfile', () => ({ getSocialProfile: mocks.profile }));
vi.mock('../../api/social', async original => ({ ...await original<typeof import('../../api/social')>(),
  prepareSocialCommand: mocks.prepare, sendSocialCommand: mocks.send, getSocialOutcome: mocks.outcome }));
vi.mock('../../api/musicShares', async original => ({ ...await original<typeof import('../../api/musicShares')>(), getMusicShares: mocks.shares }));
vi.mock('../../api/rooms', async original => ({ ...await original<typeof import('../../api/rooms')>(), getCurrentRoom: mocks.currentRoom }));
vi.mock('../../api/listener', async original => ({ ...await original<typeof import('../../api/listener')>(),
  getListenerTrack: mocks.track, getListenerAlbum: mocks.album, saveContent: mocks.save,
  saveStatusesQuery: (viewer: string, targets: unknown[]) => ({ queryKey: ['listener', 'save-statuses', viewer, targets], queryFn: mocks.statuses }) }));
vi.mock('../playback/launchPlayback', () => ({ launchStandalonePlayback: mocks.launchTrack, launchAlbumPlayback: mocks.launchAlbum }));
vi.mock('./roomSession', () => ({ roomSession: { getSnapshot: () => mocks.roomState, run: mocks.roomRun, refresh: mocks.refreshRoom }, useRoomSession: () => mocks.roomState }));
vi.mock('./roomInvitationQueries', async original => ({ ...await original<typeof import('./roomInvitationQueries')>(),
  useRoomInvitationConnection: () => ({ ready: true, roomsEnabled: true }) }));

const peer = { socialId: `s_${'a'.repeat(32)}`, handle: 'alice', alias: 'Alice', iconSeed: 'alice' };
const profile = { ...peer, active: true, discoverable: true, revision: 1 };
const share = (overrides: Partial<MusicShareItem> = {}): MusicShareItem => ({
  shareId: `ms_${'b'.repeat(32)}`, peer, contentType: 'audioTrack', contentId: 'a'.repeat(24), createdAtMs: Date.now() - 1000,
  expiresAtMs: Date.now() + 60_000, content: { contentType: 'audioTrack', id: 'a'.repeat(24), title: 'Shared track', artworkUrl: '', artistNames: ['An artist'] }, ...overrides
});
const track = (id = 'a'.repeat(24)): AudioTrackSummary => ({ contentType: 'audioTrack', id, title: 'Current track', artworkUrl: '', artistNames: ['Artist'],
  albumId: null, albumTitle: null, duration: '1:00', mediaType: 'audio', streamUrl: `/content/audioTrack/stream/${id}` });
const show = (viewer: string | null = 'viewer-1', resolving = false) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(browserSessionQueryKey, viewer ? { user: { id: viewer, email: 'private@example.test' } } : null);
  client.setQueryData(browserSessionResolvingQueryKey, resolving);
  return { client, ...render(<QueryClientProvider client={client}><MemoryRouter><MusicSharesPage /></MemoryRouter></QueryClientProvider>) };
};
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
beforeEach(() => {
  advanceAccountEpoch(); vi.clearAllMocks();
  mocks.profile.mockResolvedValue({ profile }); mocks.shares.mockResolvedValue({ items: [share()], nextCursor: null });
  mocks.prepare.mockImplementation(async (_viewer, action) => Object.freeze({ ...action, scopeToken: 'original-scope-token', commandId: 'original-command-01' }));
  mocks.send.mockResolvedValue({ commandId: 'original-command-01', outcome: 'applied', replayed: false });
  mocks.outcome.mockResolvedValue({ outcome: null }); mocks.track.mockResolvedValue({ audioTrack: track() });
  mocks.statuses.mockResolvedValue({ items: [{ contentType: 'audioTrack', contentId: 'a'.repeat(24), saved: false }] });
  mocks.save.mockResolvedValue({ contentType: 'audioTrack', contentId: 'a'.repeat(24), saved: true });
  mocks.currentRoom.mockResolvedValue({ room: null });
  mocks.roomState = { viewerId: 'viewer-1', room: null, connected: true, busy: false, uncertain: null, error: null };
});
afterEach(() => { cleanup(); musicShareSession.stop(); vi.useRealTimers(); });

test('signed-out and resolving sessions read no private profiles or shares', async () => {
  const first = show(null);
  expect(screen.getByRole('link', { name: 'Log in' })).toHaveAttribute('href', '/login?returnTo=%2Fsocial%2Fshares');
  expect(mocks.shares).not.toHaveBeenCalled(); expect(mocks.profile).not.toHaveBeenCalled(); first.unmount();
  const { client } = show('viewer-1', true);
  expect(mocks.shares).not.toHaveBeenCalled(); expect(mocks.profile).not.toHaveBeenCalled();
  await act(async () => { client.setQueryData(browserSessionResolvingQueryKey, false); });
  expect(await screen.findByText('From Alice')).toBeVisible();
  await act(async () => { client.setQueryData(browserSessionResolvingQueryKey, true); });
  await waitFor(() => expect(screen.queryByText('From Alice')).not.toBeInTheDocument());
});

test('opening and switching private lists has no playback, save, mutation or room side effects', async () => {
  show(); expect(await screen.findByText('From Alice')).toBeVisible();
  expect(mocks.track).not.toHaveBeenCalled(); expect(mocks.album).not.toHaveBeenCalled();
  expect(mocks.launchTrack).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled(); expect(mocks.roomRun).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled();
  const sent = screen.getByRole('button', { name: 'Sent' }); sent.focus();
  await userEvent.keyboard('{Enter}');
  expect(await screen.findByText('To Alice')).toBeVisible(); expect(sent).toHaveAttribute('aria-pressed', 'true');
  expect(mocks.shares).toHaveBeenLastCalledWith('viewer-1', 'outgoing', undefined, expect.any(AbortSignal));
});

test('inactive identity and failed profile or share refresh hide cached private cards', async () => {
  const { client } = show(); expect(await screen.findByText('From Alice')).toBeVisible();
  mocks.shares.mockRejectedValue(new Error('not authorized'));
  await act(async () => { await client.invalidateQueries({ queryKey: ['social', 'viewer-1', 'music-shares'] }); });
  await waitFor(() => expect(screen.queryByText('From Alice')).not.toBeInTheDocument()); expect(screen.queryByRole('button', { name: 'Play' })).not.toBeInTheDocument();
  mocks.shares.mockResolvedValue({ items: [share()], nextCursor: null });
  await act(async () => { await client.invalidateQueries({ queryKey: ['social', 'viewer-1', 'music-shares'] }); });
  expect(await screen.findByText('From Alice')).toBeVisible();
  await act(async () => { client.setQueryData(['social', 'viewer-1', 'profile'], { profile: { ...profile, active: false } }); });
  await waitFor(() => expect(screen.queryByText('From Alice')).not.toBeInTheDocument());
  expect(screen.getByText('Add a friend in Together to share music.')).toBeVisible();
});

test('logical expiry removes a displayed card without waiting for polling or server cleanup', async () => {
  mocks.shares.mockResolvedValue({ items: [share({ expiresAtMs: Date.now() + 2000 })], nextCursor: null });
  show(); expect(await screen.findByText('From Alice')).toBeVisible();
  vi.useFakeTimers(); vi.setSystemTime(Date.now() + 2100);
  act(() => { window.dispatchEvent(new Event('focus')); });
  expect(screen.queryByText('From Alice')).not.toBeInTheDocument(); expect(screen.getByText('No received music shares.')).toBeVisible();
});

test('unavailable content exposes no historical metadata or play/save but retains explicit dismissal', async () => {
  mocks.shares.mockResolvedValue({ items: [share({ content: null })], nextCursor: null }); show();
  const card = await screen.findByRole('article', { name: 'This music is unavailable.' });
  expect(within(card).queryByRole('button', { name: 'Play' })).not.toBeInTheDocument();
  expect(within(card).queryByRole('button', { name: 'Save to Library' })).not.toBeInTheDocument();
  fireEvent.click(within(card).getByRole('button', { name: 'Dismiss share' }));
  await waitFor(() => expect(mocks.send).toHaveBeenCalledWith('viewer-1', expect.objectContaining({ action: 'dismissMusicShare', shareId: share().shareId })));
});

test('explicit track Play resolves current media and Save requires its separate gesture', async () => {
  show(); const play = await screen.findByRole('button', { name: 'Play' });
  fireEvent.click(play);
  await waitFor(() => expect(mocks.launchTrack).toHaveBeenCalledExactlyOnceWith(track(), 'viewer-1'));
  expect(mocks.save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Save to Library' }));
  await waitFor(() => expect(mocks.save).toHaveBeenCalledWith('viewer-1', { contentType: 'audioTrack', contentId: 'a'.repeat(24) }));
});

test('Album Play resolves the full current ordered playable album instead of reconstructing a summary', async () => {
  const value = share({ contentType: 'album', content: { ...share().content!, contentType: 'album', title: 'Shared album' } });
  mocks.shares.mockResolvedValue({ items: [value], nextCursor: null });
  const tracks = [track('c'.repeat(24)), track('b'.repeat(24)), track('d'.repeat(24))];
  mocks.album.mockResolvedValue({ album: { id: value.contentId }, tracks });
  show(); fireEvent.click(await screen.findByRole('button', { name: 'Play' }));
  await waitFor(() => expect(mocks.launchAlbum).toHaveBeenCalledExactlyOnceWith(value.contentId, tracks, 'viewer-1'));
  expect(mocks.launchTrack).not.toHaveBeenCalled();
});

test.each(['account', 'navigation', 'room'])('an asynchronous Play cannot survive %s replacement', async cause => {
  const pending = deferred<{ audioTrack: AudioTrackSummary }>(); mocks.track.mockReturnValue(pending.promise);
  const { client, unmount } = show(); fireEvent.click(await screen.findByRole('button', { name: 'Play' }));
  if (cause === 'account') await act(async () => { advanceAccountEpoch(); client.setQueryData(browserSessionQueryKey, { user: { id: 'viewer-2' } }); });
  if (cause === 'navigation') unmount();
  if (cause === 'room') mocks.roomState.room = roomFixture();
  await act(async () => { pending.resolve({ audioTrack: track() }); });
  expect(mocks.launchTrack).not.toHaveBeenCalled();
});

test('a later explicit Play wins when two current catalog resolutions finish out of order', async () => {
  const second = share({ shareId: `ms_${'c'.repeat(32)}`, contentId: 'b'.repeat(24), content: { ...share().content!, id: 'b'.repeat(24), title: 'Second track' } });
  mocks.shares.mockResolvedValue({ items: [share(), second], nextCursor: null });
  const pending = deferred<{ audioTrack: AudioTrackSummary }>(); mocks.track.mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ audioTrack: track(second.contentId) });
  show(); const one = await screen.findByRole('article', { name: 'Shared track' });
  fireEvent.click(within(one).getByRole('button', { name: 'Play' }));
  await waitFor(() => expect(mocks.track).toHaveBeenCalledTimes(1));
  fireEvent.click(within(screen.getByRole('article', { name: 'Second track' })).getByRole('button', { name: 'Play' }));
  await waitFor(() => expect(mocks.launchTrack).toHaveBeenCalledWith(track(second.contentId), 'viewer-1'));
  await act(async () => { pending.resolve({ audioTrack: track() }); }); expect(mocks.launchTrack).toHaveBeenCalledTimes(1);
});

test.each(['guest', 'observer'])('a room %s cannot invite the sender or silently leave to play', async mode => {
  const value = roomFixture(); value.members[0].socialId = `s_${'d'.repeat(32)}`;
  if (mode === 'guest') value.hostMemberId = 'another-member'; else value.self.isController = false;
  mocks.roomState.room = value; show();
  expect(await screen.findByRole('button', { name: 'Play' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Invite to my room' })).not.toBeInTheDocument();
  expect(screen.getAllByRole('link', { name: 'Open Together' }).length).toBeGreaterThan(0);
  expect(mocks.roomRun).not.toHaveBeenCalled(); expect(mocks.launchTrack).not.toHaveBeenCalled();
});

test('Sent withdrawal captures its own share identity without affecting another incarnation', async () => {
  show(); fireEvent.click(await screen.findByRole('button', { name: 'Sent' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Withdraw share' }));
  await waitFor(() => expect(mocks.prepare).toHaveBeenCalledExactlyOnceWith('viewer-1', { action: 'withdrawMusicShare', shareId: share().shareId }));
});

test('existing room blocks personal playback and only its active host controller can explicitly invite', async () => {
  mocks.roomState.room = roomFixture(); mocks.roomState.room.members[0].socialId = `s_${'d'.repeat(32)}`; show();
  expect(await screen.findByRole('button', { name: 'Play' })).toBeDisabled(); expect(mocks.roomRun).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Invite to my room' }));
  expect(mocks.roomRun).toHaveBeenCalledExactlyOnceWith({ action: 'invite', roomId: 'room-a', memberId: 'member-a', targetSocialId: peer.socialId });
  expect(mocks.track).not.toHaveBeenCalled(); expect(mocks.launchTrack).not.toHaveBeenCalled();
});

test('cold room state performs a fresh authorized membership read before starting local music', async () => {
  mocks.currentRoom.mockResolvedValue({ room: roomFixture() }); show();
  fireEvent.click(await screen.findByRole('button', { name: 'Play' }));
  expect(await screen.findByText('Leave your current room in Together before playing this music on your own.')).toBeVisible();
  expect(mocks.currentRoom).toHaveBeenCalledExactlyOnceWith('viewer-1'); expect(mocks.refreshRoom).toHaveBeenCalledTimes(1);
  expect(mocks.track).not.toHaveBeenCalled(); expect(mocks.launchTrack).not.toHaveBeenCalled();
});

test('a failed initial membership read never starts local music', async () => {
  mocks.currentRoom.mockRejectedValue(new Error('network unavailable')); show();
  fireEvent.click(await screen.findByRole('button', { name: 'Play' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('We could not complete that action. Try again.');
  expect(mocks.track).not.toHaveBeenCalled(); expect(mocks.launchTrack).not.toHaveBeenCalled();
});

test('uncertain dismissal survives direction navigation and retry uses the same original identity', async () => {
  mocks.send.mockRejectedValueOnce(new TypeError('network disconnected'));
  show(); fireEvent.click(await screen.findByRole('button', { name: 'Dismiss share' }));
  expect(await screen.findByRole('button', { name: 'Check outcome' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Sent' }));
  expect(await screen.findByRole('button', { name: 'Withdraw share' })).toBeDisabled();
  const original = mocks.send.mock.calls[0][1]; fireEvent.click(screen.getByRole('button', { name: 'Retry this action' }));
  await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(2)); expect(mocks.send.mock.calls[1][1]).toBe(original); expect(mocks.prepare).toHaveBeenCalledTimes(1);
});
