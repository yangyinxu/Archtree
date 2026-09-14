import { StrictMode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { advanceAccountEpoch } from '../../api/accountEpoch';
import { browserSessionQueryKey, browserSessionResolvingQueryKey } from '../../api/session';
import type { RoomCommand, RoomSnapshot } from '../../api/rooms';
import * as socialApi from '../../api/social';
import * as roomMediaApi from '../../api/roomMedia';
import { roomFixture } from '../../test/roomFixture';
import RoomTrackButton from './RoomTrackButton';

const mocks = vi.hoisted(() => ({ profile: vi.fn(), friends: vi.fn(), current: vi.fn(), media: vi.fn(), community: vi.fn(), outgoing: vi.fn(),
  run: vi.fn(), refresh: vi.fn(), check: vi.fn(), retry: vi.fn(), connectionRetry: vi.fn(),
  listeners: new Set<() => void>(), connection: { ready: true, roomsEnabled: true, error: false },
  state: { viewerId: 'viewer-1', room: null as RoomSnapshot | null, connected: true, locallyPaused: false,
    busy: false, error: null as 'social.error' | 'social.unknown' | null, uncertain: null as RoomCommand | null } }));
vi.mock('../../api/rooms', async original => ({ ...await original<typeof import('../../api/rooms')>(), getCurrentRoom: mocks.current,
  getOutgoingRoomInvitations: mocks.outgoing }));
vi.mock('../../api/roomCommunity', async original => ({ ...await original<typeof import('../../api/roomCommunity')>(), getRoomCommunity: mocks.community }));
vi.mock('./roomInvitationQueries', () => ({ useRoomInvitationConnection: () => ({ ...mocks.connection, retry: mocks.connectionRetry }) }));
vi.mock('./roomSession', async () => {
  const { useSyncExternalStore } = await import('react');
  return { roomSession: { getSnapshot: () => mocks.state, run: mocks.run, refresh: mocks.refresh, checkOutcome: mocks.check, retry: mocks.retry },
    useRoomSession: () => useSyncExternalStore(callback => { mocks.listeners.add(callback); return () => { mocks.listeners.delete(callback); }; }, () => mocks.state) };
});

const track = { mediaTrackId: 'c'.repeat(24), title: 'Quiet track' };
const profile = { socialId: `s_${'a'.repeat(32)}`, handle: 'alice', alias: 'Alice', iconSeed: 'alice', active: true, discoverable: true, revision: 1 };
const friend = { socialId: `s_${'b'.repeat(32)}`, revision: 17,
  profile: { socialId: `s_${'b'.repeat(32)}`, handle: 'bobby', alias: 'Bob', iconSeed: 'bob' } };
const update = (change: Partial<typeof mocks.state>) => { mocks.state = { ...mocks.state, ...change }; for (const listener of mocks.listeners) listener(); };
const room = () => {
  const value = roomFixture(); value.timeline!.state = 'paused'; value.preparation = null;
  value.queue[0].mediaTrackId = track.mediaTrackId;
  return value;
};
const community = (pending = false) => ({ community: { roomId: 'room-a', epoch: 1, revision: 1, events: [], queueCredits: [],
  requests: pending ? [{ requestId: 'request-a', mediaTrackId: track.mediaTrackId, title: track.title,
    requestedBy: { socialId: profile.socialId, handle: profile.handle, alias: profile.alias, iconSeed: profile.iconSeed }, createdAtMs: 1000 }] : [] } });
const show = ({ viewer = 'viewer-1' as string | null, strict = false, resolving = false } = {}) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(browserSessionQueryKey, viewer ? { user: { id: viewer } } : null);
  client.setQueryData(browserSessionResolvingQueryKey, resolving);
  const content = <QueryClientProvider client={client}><MemoryRouter><RoomTrackButton {...track} /></MemoryRouter></QueryClientProvider>;
  return { client, ...render(strict ? <StrictMode>{content}</StrictMode> : content) };
};
const open = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Listen together: Quiet track' }));
  return screen.findByRole('dialog', { name: 'Listen together: Quiet track' });
};
const selectFriend = async (id = friend.socialId) => {
  const picker = await screen.findByRole('combobox', { name: 'Choose a friend' });
  await waitFor(() => expect(picker).toBeEnabled()); fireEvent.change(picker, { target: { value: id } });
};
const create = () => fireEvent.click(screen.getByRole('button', { name: 'Create paused room and invite' }));
beforeEach(() => {
  advanceAccountEpoch(); vi.clearAllMocks();
  // Spy on the real modules so StrictMode's concurrent lazy imports share the same intercepted exports.
  vi.spyOn(socialApi, 'getSocialProfile').mockImplementation(mocks.profile);
  vi.spyOn(socialApi, 'getSocialPage').mockImplementation(mocks.friends);
  vi.spyOn(roomMediaApi, 'getRoomMediaTrack').mockImplementation(mocks.media);
  mocks.connection = { ready: true, roomsEnabled: true, error: false };
  mocks.state = { viewerId: 'viewer-1', room: null, connected: true, locallyPaused: false, busy: false, error: null, uncertain: null };
  mocks.profile.mockResolvedValue({ profile }); mocks.friends.mockResolvedValue({ items: [friend], nextCursor: null });
  mocks.current.mockImplementation(async () => ({ room: mocks.state.room }));
  mocks.media.mockResolvedValue({ item: { ...roomFixture().queue[0], ...track } });
  mocks.community.mockResolvedValue(community()); mocks.outgoing.mockResolvedValue({ invitations: [{ recipientSocialId: friend.socialId, expiresAtMs: Date.now() + 60_000 }] });
  mocks.run.mockImplementation(async action => { if (action.action === 'create') update({ room: room() }); });
  mocks.refresh.mockResolvedValue(true); mocks.check.mockResolvedValue(undefined); mocks.retry.mockResolvedValue(undefined);
});
afterEach(cleanup);

test('opening while signed out is an authentication explanation without any private reads or mutation', async () => {
  show({ viewer: null }); expect(mocks.profile).not.toHaveBeenCalled(); const dialog = await open();
  expect(within(dialog).getByRole('link', { name: 'Log in' })).toHaveAttribute('href', '/login?returnTo=%2Fsocial');
  expect(mocks.profile).not.toHaveBeenCalled(); expect(mocks.friends).not.toHaveBeenCalled(); expect(mocks.current).not.toHaveBeenCalled();
  expect(mocks.media).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled();
});

test('an unresolved session and inactive social profile never mount room or friend reads', async () => {
  const { client } = show({ resolving: true }); await open(); expect(mocks.profile).not.toHaveBeenCalled();
  mocks.profile.mockResolvedValue({ profile: { ...profile, active: false } });
  await act(async () => { client.setQueryData(browserSessionResolvingQueryKey, false); });
  expect(await screen.findByText('Set up your social profile in Together to listen with friends.')).toBeVisible();
  expect(mocks.friends).not.toHaveBeenCalled(); expect(mocks.media).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled();
});

test('unsupported exact tracks explain eligibility and cannot create or request', async () => {
  mocks.media.mockResolvedValue({ item: null }); show(); await open();
  expect(await screen.findByText('This song is not available for shared rooms yet.')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Create paused room and invite' })).toBeDisabled();
  expect(mocks.media).toHaveBeenCalledWith('viewer-1', track.mediaTrackId, expect.any(AbortSignal)); expect(mocks.run).not.toHaveBeenCalled();
});

test('disabled admission keeps the explanation and blocks creation without eligibility reads', async () => {
  mocks.connection.roomsEnabled = false; show(); await open();
  expect(await screen.findByText('Joining rooms is temporarily unavailable.')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Create paused room and invite' })).toBeDisabled(); expect(mocks.media).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled();
});

test('StrictMode creates a paused room then separately invites only after explicit friend confirmation', async () => {
  show({ strict: true }); await open(); await selectFriend(); expect(mocks.current).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled();
  create(); create();
  expect(await screen.findByText('Invitation sent. Open Together when you are ready to start listening.')).toBeVisible();
  expect(mocks.run.mock.calls.map(([action]) => action)).toEqual([{ action: 'create', mediaTrackIds: [track.mediaTrackId] },
    { action: 'invite', roomId: 'room-a', memberId: 'member-a', targetSocialId: friend.socialId }]);
  expect(mocks.state.room?.timeline?.state).toBe('paused'); expect(mocks.outgoing).toHaveBeenCalledExactlyOnceWith('viewer-1', 'room-a');
});

test('server-confirmed invitation feedback does not expire according to an ahead-of-server device clock', async () => {
  show(); await open(); await selectFriend();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 48 * 60 * 60 * 1000);
  try {
    create(); expect(await screen.findByText('Invitation sent. Open Together when you are ready to start listening.')).toBeVisible();
    expect(mocks.run).toHaveBeenCalledTimes(2);
  } finally { clock.mockRestore(); }
});

test('creation preflight discovering a room only refreshes and requires another explicit action', async () => {
  mocks.current.mockResolvedValue({ room: room() }); mocks.refresh.mockImplementation(async () => update({ room: room() }));
  show(); await open(); await selectFriend(); create();
  expect(await screen.findByText('Your room changed. Review the current room before trying again.')).toBeVisible();
  expect(mocks.refresh).toHaveBeenCalledTimes(1); expect(mocks.run).not.toHaveBeenCalled();
});

test('a room appearing while exact eligibility is pending cannot receive an unintended invitation', async () => {
  let resolve!: (value: { item: ReturnType<typeof room>['queue'][number] }) => void;
  show(); await open(); await selectFriend(); mocks.media.mockReturnValueOnce(new Promise(yes => { resolve = yes; })); create();
  await waitFor(() => expect(mocks.media).toHaveBeenCalledTimes(2));
  await act(async () => { update({ room: room() }); resolve({ item: room().queue[0] }); });
  expect(await screen.findByText('Your room changed. Review the current room before trying again.')).toBeVisible(); expect(mocks.run).not.toHaveBeenCalled();
});

test('a source losing eligibility after opening is rechecked before any command', async () => {
  show(); await open(); await selectFriend(); mocks.media.mockResolvedValue({ item: null }); create();
  expect(await screen.findByText('This song is not available for shared rooms yet.')).toBeVisible(); expect(mocks.run).not.toHaveBeenCalled();
});

test.each([false, true])('an admitted member (observer=%s) can request without changing shared playback', async observer => {
  const value = room(); value.controlMode = 'hostOnly'; value.hostMemberId = 'host-other'; value.self.isController = !observer; value.self.canControl = false;
  mocks.state.room = value; mocks.run.mockImplementation(async () => { mocks.community.mockResolvedValue(community(true)); });
  show(); await open(); const request = await screen.findByRole('button', { name: 'Request song' });
  await waitFor(() => expect(request).toBeEnabled()); fireEvent.click(request);
  expect(await screen.findByText('Requested. Waiting for the host.')).toBeVisible();
  expect(mocks.run).toHaveBeenCalledExactlyOnceWith({ action: 'requestSong', roomId: 'room-a', memberId: 'member-a', expectedEpoch: 1, mediaTrackId: track.mediaTrackId });
  expect(value.timeline?.state).toBe('paused'); expect(value.queue).toHaveLength(1);
});

test('an accepted request remains unconfirmed until an authoritative community read contains it', async () => {
  mocks.state.room = room(); let resolve!: (value: ReturnType<typeof community>) => void;
  mocks.run.mockImplementation(async () => { mocks.community.mockReturnValue(new Promise(yes => { resolve = yes; })); });
  show(); await open(); const request = await screen.findByRole('button', { name: 'Request song' }); await waitFor(() => expect(request).toBeEnabled());
  fireEvent.click(request); await waitFor(() => expect(mocks.community).toHaveBeenCalledTimes(2));
  expect(screen.queryByText('Requested. Waiting for the host.')).not.toBeInTheDocument();
  await act(async () => { resolve(community(true)); });
  expect(await screen.findByText('Requested. Waiting for the host.')).toBeVisible();
});

test('a failed post-command community read does not report a waiting request', async () => {
  mocks.state.room = room(); mocks.run.mockImplementation(async () => { mocks.community.mockRejectedValue(new Error('unavailable')); });
  show(); await open(); const request = await screen.findByRole('button', { name: 'Request song' }); await waitFor(() => expect(request).toBeEnabled()); fireEvent.click(request);
  expect(await screen.findByRole('alert')).toBeVisible(); expect(screen.queryByText('Requested. Waiting for the host.')).not.toBeInTheDocument();
});

test('an existing own pending request is confirmed from the community without sending a duplicate', async () => {
  mocks.state.room = room(); mocks.community.mockResolvedValue(community(true)); show(); await open();
  expect(await screen.findByText('Requested. Waiting for the host.')).toBeVisible(); expect(screen.getByRole('button', { name: 'Request song' })).toBeDisabled(); expect(mocks.run).not.toHaveBeenCalled();
});

test('request preflight rejects a changed room membership without sending to either room', async () => {
  mocks.state.room = room(); show(); await open(); const request = await screen.findByRole('button', { name: 'Request song' }); await waitFor(() => expect(request).toBeEnabled());
  mocks.current.mockResolvedValue({ room: { ...room(), roomId: 'other-room' } }); fireEvent.click(request);
  expect(await screen.findByText('Your room changed. Review the current room before trying again.')).toBeVisible(); expect(mocks.run).not.toHaveBeenCalled();
});

test('uncertain creation stays recoverable after closing and never continues into an invitation', async () => {
  const command = { action: 'create' as const, mediaTrackIds: [track.mediaTrackId], commandId: 'original-command', scopeToken: 'original-scope' };
  mocks.run.mockImplementation(async () => update({ uncertain: command, error: 'social.unknown' })); show(); await open(); await selectFriend(); create();
  await screen.findByRole('button', { name: 'Check outcome' }); expect(mocks.run).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Close' })); await open();
  expect(screen.getByRole('button', { name: 'Create paused room and invite' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Check outcome' })); expect(mocks.check).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Retry this action' })); expect(mocks.retry).toHaveBeenCalledTimes(1);
  expect(mocks.state.uncertain).toBe(command); expect(mocks.run).toHaveBeenCalledTimes(1);
});

test('invitation failure retains the newly created paused room and reports no false success', async () => {
  mocks.run.mockImplementation(async action => { if (action.action === 'create') update({ room: room() }); else update({ error: 'social.error' }); });
  show(); await open(); await selectFriend(); create();
  await waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(2)); expect(mocks.state.room?.timeline?.state).toBe('paused');
  expect(screen.queryByText('Invitation sent. Open Together when you are ready to start listening.')).not.toBeInTheDocument(); expect(mocks.outgoing).not.toHaveBeenCalled();
});

test('a different membership found after creation is never the destination of the chained invitation', async () => {
  mocks.current.mockResolvedValueOnce({ room: null }).mockResolvedValue({ room: { ...room(), roomId: 'other-room' } });
  show(); await open(); await selectFriend(); create();
  expect(await screen.findByText('Your room changed. Review the current room before trying again.')).toBeVisible();
  expect(mocks.run).toHaveBeenCalledExactlyOnceWith({ action: 'create', mediaTrackIds: [track.mediaTrackId] });
});

test('unknown invitation preserves its original recovery and the created room across dialog reopen', async () => {
  const command = { action: 'invite' as const, roomId: 'room-a', memberId: 'member-a', targetSocialId: friend.socialId,
    commandId: 'original-invitation', scopeToken: 'original-scope' };
  mocks.run.mockImplementation(async action => { if (action.action === 'create') update({ room: room() }); else update({ uncertain: command, error: 'social.unknown' }); });
  show(); await open(); await selectFriend(); create(); await screen.findByRole('button', { name: 'Check outcome' });
  fireEvent.click(screen.getByRole('button', { name: 'Close' })); await open();
  expect(await screen.findByRole('button', { name: 'Retry this action' })).toBeEnabled();
  expect(await screen.findByRole('button', { name: 'Request song' })).toBeDisabled();
  expect(mocks.run).toHaveBeenCalledTimes(2); expect(mocks.state.uncertain).toBe(command); expect(mocks.state.room?.timeline?.state).toBe('paused');
});

test('friend pagination exposes the next authorized page and uses its selected identity', async () => {
  const nextFriend = { ...friend, socialId: `s_${'d'.repeat(32)}`, profile: { ...friend.profile, socialId: `s_${'d'.repeat(32)}`, alias: 'Dana', handle: 'dana' } };
  mocks.friends.mockResolvedValueOnce({ items: [friend], nextCursor: 'page-two' }).mockResolvedValue({ items: [nextFriend], nextCursor: null });
  show(); await open(); await selectFriend(); fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
  await screen.findByRole('option', { name: 'Dana (@dana)' }); await selectFriend(nextFriend.socialId); create();
  await waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(2)); expect(mocks.run.mock.calls[1][0].targetSocialId).toBe(nextFriend.socialId);
  expect(mocks.friends).toHaveBeenCalledWith('viewer-1', 'friends', 'page-two', expect.any(AbortSignal));
});

test.each(['unmount', 'account change', 'session resolving', 'profile deactivation'])('%s during preflight fences its continuation', async change => {
  let resolve!: (value: { room: null }) => void; mocks.current.mockReturnValue(new Promise(yes => { resolve = yes; }));
  const view = show({ strict: true }); await open(); await selectFriend(); create();
  await waitFor(() => expect(mocks.current).toHaveBeenCalledTimes(1));
  await act(async () => {
    if (change === 'unmount') view.unmount(); else if (change === 'account change') advanceAccountEpoch();
    else if (change === 'profile deactivation') view.client.setQueryData(['social', 'viewer-1', 'profile'], { profile: { ...profile, active: false } });
    else view.client.setQueryData(browserSessionResolvingQueryKey, true);
  });
  await act(async () => { resolve({ room: null }); }); expect(mocks.run).not.toHaveBeenCalled();
});

test('closing while creation is pending leaves the result recoverable without sending an invitation', async () => {
  let resolve!: () => void; mocks.run.mockImplementation(() => new Promise<void>(yes => { resolve = () => { update({ room: room() }); yes(); }; }));
  show({ strict: true }); await open(); await selectFriend(); create(); await waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button', { name: 'Close' })); await act(async () => { resolve(); });
  expect(mocks.run).toHaveBeenCalledTimes(1); await open(); expect(await screen.findByRole('button', { name: 'Request song' })).toBeVisible();
  expect(mocks.run).toHaveBeenCalledTimes(1);
});

test('a suspended room explains why requests are disabled without claiming an inactive read is loading', async () => {
  const current = room(); current.status = 'suspended'; mocks.state.room = current;
  show(); const dialog = await open();
  const button = await within(dialog).findByRole('button', { name: 'Request song' });
  await waitFor(() => expect(mocks.media).toHaveBeenCalled());
  expect(button).toBeDisabled();
  expect(within(dialog).getByText('The host is disconnected. Shared playback is suspended.')).toBeVisible();
  expect(mocks.community).not.toHaveBeenCalled();
});
