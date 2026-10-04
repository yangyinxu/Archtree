import { QueryClient } from '@tanstack/react-query';

import { roomFixture } from '../../test/roomFixture';
import { advanceAccountEpoch } from '../../api/accountEpoch';
import { subscribeToAccountSessionChanges } from '../../api/accountSessionEvents';
import type { BrowserSession } from '../../api/schemas';
import { browserSessionQueryKey } from '../../api/session';
import { startBrowserSessionCoordinator } from '../../app/BrowserSessionCoordinator';

const player = vi.hoisted(() => ({ detach: vi.fn() }));
vi.mock('../../player', () => ({ playerStore: {
  notePlaybackIntent: vi.fn(),
  attachRoomPlayback: vi.fn(() => ({
    apply: vi.fn().mockResolvedValue(true), pauseLocally: vi.fn(), detach: player.detach,
    resync: vi.fn().mockResolvedValue(undefined), correct: vi.fn()
  }))
} }));
import { roomSession } from './roomSession';

/** Only the realtime transport is replaced; tickets, room reads and session recovery use the real client. */
class Socket {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances: Socket[] = [];
  readyState = 0;
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
  onerror?: () => void;
  constructor() { Socket.instances.push(this); }
  send() { /* Heartbeats need no acknowledgement in these lifecycle tests. */ }
  close() { this.readyState = 3; this.onclose?.(); }
  receive(value: unknown) { this.readyState = 1; this.onmessage?.({ data: JSON.stringify(value) }); }
}

const sessionFor = (id: string): BrowserSession => ({ user: {
  id, email: `${id}@example.test`, role: 'user', displayName: id, avatarRevision: 0, avatar: null, emailVerified: true
} });
const respond = (body: unknown, status = 200, viewer?: string | null) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', ...(viewer ? { 'X-Finitude-Account-Viewer': viewer } : {}) }
});

/** A same-origin server whose browser session can end from another device, as sign out everywhere does. */
const installServer = () => {
  const server = { account: 'viewer-a' as string | null, refreshStatus: 401, ticketGate: undefined as Promise<void> | undefined };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const viewer = new Headers(init?.headers).get('X-Finitude-Account-Viewer');
    if (path === '/api/listener/v1/telemetry') return new Response(null, { status: 204 });
    if (path === '/auth/browser/refresh') return respond({}, server.refreshStatus);
    if (path === '/auth/browser/session') {
      return server.account ? respond(sessionFor(server.account), 200, server.account) : respond({}, 401);
    }
    const gate = path === '/api/social/v1/realtime-tickets' ? server.ticketGate : undefined;
    if (gate) {
      // A held ticket belongs to an account whose session ends before the answer arrives.
      await gate;
      return respond({}, 401);
    }
    if (!server.account || viewer !== server.account) return respond({}, 401);
    if (path === '/api/social/v1/rooms/current') return respond({ room: roomFixture() }, 200, viewer);
    if (path === '/api/social/v1/realtime-tickets') {
      return respond({ ticket: 'single-use-ticket-123', expiresAt: new Date(Date.now() + 30_000).toISOString() }, 200, viewer);
    }
    throw new Error(`Unexpected request ${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  const calls = (path: string) => fetchMock.mock.calls.filter(([input]) => String(input) === path).length;
  return { server, calls };
};

let queryClient: QueryClient;
let stopCoordinator: () => void;
let reasons: string[];
let stopRecording: () => void;
beforeEach(() => {
  roomSession.stop(); vi.useFakeTimers(); vi.clearAllMocks(); Socket.instances = [];
  vi.stubGlobal('WebSocket', Socket);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(browserSessionQueryKey, sessionFor('viewer-a'));
  stopCoordinator = startBrowserSessionCoordinator(queryClient);
  reasons = [];
  stopRecording = subscribeToAccountSessionChanges(event => { reasons.push(event.reason); });
});
afterEach(() => {
  stopRecording(); stopCoordinator(); roomSession.stop(); queryClient.clear();
  window.localStorage.clear(); vi.useRealTimers();
});

/** The host's controller tab is playing in its room before another device signs the account out. */
const hostInRoom = async () => {
  roomSession.ensure('viewer-a', vi.fn());
  await vi.advanceTimersByTimeAsync(0);
  await vi.waitFor(() => expect(Socket.instances).toHaveLength(1));
  Socket.instances[0].receive({ type: 'subscribed', protocolVersion: 1, serverTimeMs: 1_000_000, room: roomFixture() });
  await vi.dynamicImportSettled();
  expect(roomSession.getSnapshot()).toMatchObject({ viewerId: 'viewer-a', connected: true, room: { roomId: 'room-a' } });
};

test.each(['realtime reconnect', 'End room'] as const)(
  'a %s that proves sign out everywhere drops the room and signs the tab out', async (trigger) => {
    const { server, calls } = installServer();
    await hostInRoom();
    server.account = null;
    if (trigger === 'realtime reconnect') {
      // The server closes the revoked controller's socket; the ordinary reconnect asks for a ticket.
      Socket.instances[0].close();
      expect(roomSession.getSnapshot().room).not.toBeNull();
      await vi.advanceTimersByTimeAsync(3_000);
    } else {
      await roomSession.run({ action: 'end', roomId: 'room-a', memberId: 'member-a' });
    }
    await vi.waitFor(() => expect(queryClient.getQueryState(browserSessionQueryKey)).toMatchObject({ status: 'success', data: null }));
    expect(roomSession.getSnapshot()).toMatchObject({ viewerId: '', room: null, connected: false, error: null, uncertain: null });
    expect(player.detach).toHaveBeenCalled();
    expect(reasons).toEqual(['logout']);

    // Nothing keeps retrying the revoked account's room once the tab has reconciled.
    const tickets = calls('/api/social/v1/realtime-tickets');
    const reads = calls('/api/social/v1/rooms/current');
    const refreshes = calls('/auth/browser/refresh');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls('/api/social/v1/realtime-tickets')).toBe(tickets);
    expect(calls('/api/social/v1/rooms/current')).toBe(reads);
    expect(calls('/auth/browser/refresh')).toBe(refreshes);
    expect(reasons).toEqual(['logout']);
  }
);

test('a 401 whose recovery cannot prove the session ended keeps the room and retries', async () => {
  const { server, calls } = installServer();
  await hostInRoom();
  server.account = null;
  server.refreshStatus = 503;
  Socket.instances[0].close();
  await vi.advanceTimersByTimeAsync(3_000);
  await vi.waitFor(() => expect(roomSession.getSnapshot().error).toBe('room.disconnected'));
  expect(roomSession.getSnapshot()).toMatchObject({ viewerId: 'viewer-a', connected: false, room: { roomId: 'room-a' } });
  expect(queryClient.getQueryData(browserSessionQueryKey)).toEqual(sessionFor('viewer-a'));
  expect(reasons).toEqual([]);
  // A temporary outage stays recoverable: the heartbeat asks again instead of giving up.
  const tickets = calls('/api/social/v1/realtime-tickets');
  await vi.advanceTimersByTimeAsync(5_000);
  expect(calls('/api/social/v1/realtime-tickets')).toBeGreaterThan(tickets);
});

test('a former account ticket answered 401 after another tab changed accounts cannot sign the replacement out', async () => {
  const { server, calls } = installServer();
  let releaseTicket!: () => void;
  server.ticketGate = new Promise<void>((resolve) => { releaseTicket = resolve; });
  roomSession.ensure('viewer-a', vi.fn());
  await vi.waitFor(() => expect(calls('/api/social/v1/realtime-tickets')).toBe(1));

  // Another tab replaced the account; this tab already reconciled to the replacement viewer.
  server.account = 'viewer-b';
  advanceAccountEpoch();
  queryClient.setQueryData(browserSessionQueryKey, sessionFor('viewer-b'));
  server.ticketGate = undefined;
  roomSession.ensure('viewer-b', vi.fn());
  await vi.waitFor(() => expect(Socket.instances).toHaveLength(1));

  const sessionReads = calls('/auth/browser/session');
  releaseTicket();
  await vi.advanceTimersByTimeAsync(0);
  // The stale epoch stops recovery before it can inspect or end the shared session.
  expect(calls('/auth/browser/session')).toBe(sessionReads);
  expect(calls('/auth/browser/refresh')).toBe(0);
  expect(reasons).toEqual([]);
  expect(queryClient.getQueryData(browserSessionQueryKey)).toEqual(sessionFor('viewer-b'));
  expect(roomSession.getSnapshot().viewerId).toBe('viewer-b');
});
