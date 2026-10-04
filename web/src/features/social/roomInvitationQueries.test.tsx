import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { advanceAccountEpoch } from '../../api/accountEpoch';
import type { RoomCommunity } from '../../api/roomCommunity';
import type { RoomSnapshot } from '../../api/rooms';
import { roomFixture } from '../../test/roomFixture';
import { useRoomInvitationConnection, useRoomInvitations } from './roomInvitationQueries';
import { useRoomCommunity } from './useRoomCommunity';

type RefreshKind = 'social' | 'rooms' | 'community';
const mocks = vi.hoisted(() => ({ community: vi.fn(), invitations: vi.fn(), outgoing: vi.fn(), capabilities: vi.fn(),
  refresh: undefined as ((kind: RefreshKind) => void) | undefined, ensures: [] as unknown[],
  state: { viewerId: 'viewer-1', room: null as RoomSnapshot | null } }));
vi.mock('../../api/roomCommunity', () => ({ getRoomCommunity: mocks.community }));
vi.mock('../../api/rooms', () => ({ getRoomCapabilities: mocks.capabilities, getRoomInvitations: mocks.invitations }));
vi.mock('./roomSession', () => ({ roomSession: { getSnapshot: () => mocks.state,
  ensure: (_viewer: string, refresh: (kind: RefreshKind) => void, options: unknown) => { mocks.refresh = refresh; mocks.ensures.push(options); } } }));

const communityFor = (room: RoomSnapshot): RoomCommunity => ({ roomId: room.roomId, epoch: room.epoch, revision: room.revision,
  requests: [], queueCredits: [], events: [] });
const cardFor = (room: RoomSnapshot) => {
  const { socialId, handle, alias, iconSeed } = room.members[0];
  return { socialId, handle, alias, iconSeed };
};
let serverCommunity: RoomCommunity;
const clients: QueryClient[] = [];
const tick = async (ms = 0) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const notify = async (kind: RefreshKind) => { act(() => { mocks.refresh!(kind); }); await tick(); };

/** Real query observers exercise the session callback rather than inspecting an invalidation predicate. */
const show = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client);
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return renderHook(({ viewer, room }) => {
    useRoomInvitationConnection(viewer);
    const invitations = useRoomInvitations(viewer);
    const outgoing = useQuery({ queryKey: ['social', viewer, 'room-outgoing-invitations', room.roomId], queryFn: mocks.outgoing });
    const community = useRoomCommunity(viewer, room, true);
    return { invitations, outgoing, community };
  }, { initialProps: { viewer: 'viewer-1', room: mocks.state.room! }, wrapper });
};

beforeEach(() => {
  advanceAccountEpoch(); vi.useFakeTimers(); vi.setSystemTime(1_000_000); vi.clearAllMocks(); mocks.refresh = undefined; mocks.ensures = [];
  mocks.state = { viewerId: 'viewer-1', room: roomFixture() }; serverCommunity = communityFor(mocks.state.room!);
  mocks.capabilities.mockResolvedValue({ socialEnabled: true, roomsEnabled: true });
  mocks.invitations.mockResolvedValue({ invitations: [] }); mocks.outgoing.mockResolvedValue({ invitations: [] });
  mocks.community.mockImplementation(async () => ({ community: structuredClone(serverCommunity) }));
});
afterEach(() => { cleanup(); for (const client of clients.splice(0)) client.clear(); vi.useRealTimers(); });

test('invitation-only settlement refreshes invitation observers without an extra community GET', async () => {
  const view = show(); await tick(); expect(view.result.current.community.data).toEqual({ community: serverCommunity });
  expect(mocks.community).toHaveBeenCalledTimes(1);
  await notify('rooms');
  expect(mocks.invitations).toHaveBeenCalledTimes(2); expect(mocks.outgoing).toHaveBeenCalledTimes(2);
  expect(mocks.community).toHaveBeenCalledTimes(1);
});

test('a social change signal, from the socket or its HTTP fallback, refreshes friend requests and received shares', async () => {
  const requests = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
  const shares = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client);
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  renderHook(() => {
    useRoomInvitationConnection('viewer-1');
    useQuery({ queryKey: ['social', 'viewer-1', 'relationships', 'incoming'], queryFn: requests });
    useQuery({ queryKey: ['social', 'viewer-1', 'music-shares', 'incoming'], queryFn: shares });
  }, { wrapper });
  await tick();
  expect(requests).toHaveBeenCalledOnce(); expect(shares).toHaveBeenCalledOnce();
  await notify('social');
  expect(requests).toHaveBeenCalledTimes(2); expect(shares).toHaveBeenCalledTimes(2);
  // Room-only settlement and community changes leave the friendship and share reads alone.
  await notify('rooms'); await notify('community');
  expect(requests).toHaveBeenCalledTimes(2); expect(shares).toHaveBeenCalledTimes(2);
  expect(mocks.capabilities).toHaveBeenCalledOnce();
});

test.each(['requestSong', 'react'])('%s with only a newer room revision still refreshes the complete community', async action => {
  const view = show(); await tick();
  const room = { ...mocks.state.room!, revision: 2 }; const actor = cardFor(room);
  serverCommunity = { ...communityFor(room), ...(action === 'requestSong'
    ? { requests: [{ requestId: 'request-a', mediaTrackId: room.queue[0].mediaTrackId, title: 'Recommended song', requestedBy: actor, createdAtMs: Date.now() }] }
    : { events: [{ eventId: 'event-a', kind: 'reaction' as const, actor, reaction: 'heart' as const, createdAtMs: Date.now(), expiresAtMs: Date.now() + 30_000 }] }) };
  mocks.state.room = room; view.rerender({ viewer: 'viewer-1', room }); await tick(751);
  expect(mocks.community).toHaveBeenCalledTimes(2); expect(view.result.current.community.data?.community).toEqual(serverCommunity);
});

test('explicit community invalidation remains immediate and does not refetch invitation lists', async () => {
  const view = show(); await tick();
  serverCommunity.requests = [{ requestId: 'request-a', mediaTrackId: mocks.state.room!.queue[0].mediaTrackId,
    title: 'Recommended song', requestedBy: cardFor(mocks.state.room!), createdAtMs: Date.now() }];
  await notify('community');
  expect(mocks.community).toHaveBeenCalledTimes(2); expect(view.result.current.community.data?.community).toEqual(serverCommunity);
  expect(mocks.invitations).toHaveBeenCalledTimes(1); expect(mocks.outgoing).toHaveBeenCalledTimes(1);
});

test('same-revision social card changes still replace community attribution', async () => {
  const room = mocks.state.room!;
  serverCommunity.requests = [{ requestId: 'request-a', mediaTrackId: room.queue[0].mediaTrackId,
    title: 'Recommended song', requestedBy: cardFor(room), createdAtMs: Date.now() }];
  const view = show(); await tick();
  serverCommunity.requests[0].requestedBy.alias = 'Updated alias';
  await notify('social');
  expect(mocks.community).toHaveBeenCalledTimes(2);
  expect(view.result.current.community.data?.community.requests[0].requestedBy.alias).toBe('Updated alias');
  expect(mocks.invitations).toHaveBeenCalledTimes(2); expect(mocks.outgoing).toHaveBeenCalledTimes(2);
});

test('a second same-revision social change replaces an in-flight read instead of accepting stale cards', async () => {
  const room = mocks.state.room!;
  serverCommunity.requests = [{ requestId: 'request-a', mediaTrackId: room.queue[0].mediaTrackId,
    title: 'Recommended song', requestedBy: cardFor(room), createdAtMs: Date.now() }];
  const view = show(); await tick();
  const oldCommunity = structuredClone(serverCommunity);
  let resolveOld!: (value: { community: RoomCommunity }) => void;
  let oldSignal: AbortSignal | undefined;
  mocks.community.mockImplementationOnce((_viewer: string, _roomId: string, signal?: AbortSignal) => new Promise((resolve, reject) => {
    resolveOld = resolve; oldSignal = signal;
    signal?.addEventListener('abort', () => reject(new DOMException('Canceled.', 'AbortError')), { once: true });
  }));
  await notify('social'); expect(mocks.community).toHaveBeenCalledTimes(2);
  serverCommunity.requests[0].requestedBy.alias = 'Latest alias';
  await notify('social');
  expect(oldSignal?.aborted).toBe(true); expect(mocks.community).toHaveBeenCalledTimes(3);
  expect(view.result.current.community.data?.community.requests[0].requestedBy.alias).toBe('Latest alias');
  await act(async () => { resolveOld({ community: oldCommunity }); }); await tick();
  expect(view.result.current.community.data?.community.requests[0].requestedBy.alias).toBe('Latest alias');
});

test.each(['epoch', 'membership', 'room'])('%s replacement fetches its current membership-scoped community', async change => {
  const view = show(); await tick(); const room = structuredClone(mocks.state.room!);
  if (change === 'epoch') room.epoch = 2;
  if (change === 'membership') room.self.memberId = room.members[0].memberId = 'member-returned';
  if (change === 'room') room.roomId = 'room-b';
  mocks.state.room = room; serverCommunity = communityFor(room); view.rerender({ viewer: 'viewer-1', room }); await tick();
  expect(mocks.community).toHaveBeenCalledTimes(2); expect(view.result.current.community.data?.community).toEqual(serverCommunity);
  await notify('rooms'); expect(mocks.community).toHaveBeenCalledTimes(2);
});

test('host transfer refreshes confirmed activity through the newer snapshot revision', async () => {
  const view = show(); await tick(); const room = structuredClone(mocks.state.room!);
  room.revision = 2; room.hostMemberId = 'member-b'; room.members[0].role = 'guest';
  const host = { ...room.members[0], memberId: 'member-b', socialId: `s_${'b'.repeat(32)}`, handle: 'bobby', alias: 'Bob', role: 'host' as const };
  room.members.push(host);
  serverCommunity = { ...communityFor(room), events: [{ eventId: 'event-transfer', kind: 'hostChanged', actor: cardFor({ ...room, members: [host] }),
    reaction: null, createdAtMs: Date.now(), expiresAtMs: Date.now() + 30_000 }] };
  mocks.state.room = room; view.rerender({ viewer: 'viewer-1', room }); await tick(751);
  expect(mocks.community).toHaveBeenCalledTimes(2); expect(view.result.current.community.data?.community.events).toEqual(serverCommunity.events);
  await notify('rooms'); expect(mocks.community).toHaveBeenCalledTimes(2);
});

test.each(['leave', 'ended', 'account'])('%s retires the former room before active observers unmount', async cause => {
  show(); await tick();
  if (cause === 'leave') mocks.state.room = null;
  if (cause === 'ended') mocks.state.room = { ...mocks.state.room!, status: 'ended' };
  if (cause === 'account') { advanceAccountEpoch(); mocks.state.viewerId = 'viewer-2'; }
  await notify('rooms'); await notify('community'); await notify('social');
  expect(mocks.community).toHaveBeenCalledTimes(1); expect(mocks.outgoing).toHaveBeenCalledTimes(1);
});

test('every successful capability read re-applies the rollout so a gate-stopped transport can resume', async () => {
  show(); await tick();
  expect(mocks.ensures).toEqual([{ realtimeEnabled: true }]);
  // An unchanged response still re-applies the switch; the session ignores it unless its own state differs.
  await tick(30_000);
  expect(mocks.capabilities).toHaveBeenCalledTimes(2);
  expect(mocks.ensures).toEqual([{ realtimeEnabled: true }, { realtimeEnabled: true }]);
  mocks.capabilities.mockResolvedValue({ socialEnabled: true, roomsEnabled: false });
  await tick(30_000);
  expect(mocks.ensures.at(-1)).toEqual({ realtimeEnabled: false });
});
