import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { advanceAccountEpoch } from '../../api/accountEpoch';
import type { RoomCommunity } from '../../api/roomCommunity';
import { roomFixture } from '../../test/roomFixture';
import { useRoomCommunity } from './useRoomCommunity';

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../api/roomCommunity', () => ({ getRoomCommunity: mocks.get }));
const payload = (revision = 1, roomId = 'room-a', epoch = 1): { community: RoomCommunity } => ({ community: {
  roomId, epoch, revision, requests: [], queueCredits: [], events: []
} });
const tick = async (ms = 0) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const show = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const view = renderHook(({ viewer, room, enabled }) => useRoomCommunity(viewer, room, enabled), {
    initialProps: { viewer: 'viewer-1', room: roomFixture(), enabled: true }, wrapper
  });
  return { client, ...view };
};
beforeEach(() => { advanceAccountEpoch(); vi.useFakeTimers(); vi.setSystemTime(1_000_000); mocks.get.mockReset(); mocks.get.mockResolvedValue(payload()); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

test('initial fetch has no duplicate and a fresh server revision suppresses needless reads', async () => {
  mocks.get.mockResolvedValue(payload(8)); const view = show(); await tick();
  expect(mocks.get).toHaveBeenCalledTimes(1);
  for (const revision of [2, 4, 8]) { view.rerender({ viewer: 'viewer-1', room: { ...roomFixture(), revision }, enabled: true }); await tick(750); }
  expect(mocks.get).toHaveBeenCalledTimes(1); expect(view.result.current.data?.community.revision).toBe(8);
});

test('continuous snapshot bursts get leading and trailing reads without starvation or timer resetting', async () => {
  let latest = 1; mocks.get.mockImplementation(async () => payload(latest)); const view = show(); await tick();
  await tick(800); latest = 2; view.rerender({ viewer: 'viewer-1', room: { ...roomFixture(), revision: latest }, enabled: true }); await tick();
  expect(mocks.get).toHaveBeenCalledTimes(2);
  for (let index = 0; index < 7; index++) {
    await tick(100); latest++; view.rerender({ viewer: 'viewer-1', room: { ...roomFixture(), revision: latest }, enabled: true });
  }
  expect(mocks.get).toHaveBeenCalledTimes(2); await tick(50); expect(mocks.get).toHaveBeenCalledTimes(3);
  await tick(1);
  expect(view.result.current.data?.community.revision).toBe(latest);
});

test('a revision that arrives during an in-flight read gets one bounded catch-up after completion', async () => {
  let resolve!: (value: ReturnType<typeof payload>) => void;
  mocks.get.mockReturnValueOnce(new Promise(done => { resolve = done; })).mockResolvedValue(payload(4));
  const view = show(); await tick(); view.rerender({ viewer: 'viewer-1', room: { ...roomFixture(), revision: 4 }, enabled: true });
  await tick(800); expect(mocks.get).toHaveBeenCalledTimes(1);
  await act(async () => { resolve(payload(1)); }); await tick();
  await tick(1);
  expect(mocks.get).toHaveBeenCalledTimes(2); expect(view.result.current.data?.community.revision).toBe(4);
});

test('a failed read does not loop or prevent an explicit retry or later revision', async () => {
  mocks.get.mockRejectedValue(new Error('temporarily unavailable')); const view = show(); await tick();
  await tick(2000); expect(mocks.get).toHaveBeenCalledTimes(1);
  view.rerender({ viewer: 'viewer-1', room: { ...roomFixture(), revision: 2 }, enabled: true }); await tick();
  expect(mocks.get).toHaveBeenCalledTimes(2); await tick(2000); expect(mocks.get).toHaveBeenCalledTimes(2);
  mocks.get.mockResolvedValue(payload(2)); await act(async () => { await view.result.current.refetch(); }); await tick();
  expect(mocks.get).toHaveBeenCalledTimes(3); expect(view.result.current.isError).toBe(false);
});

test.each(['room', 'epoch', 'member', 'account', 'disabled', 'unmount'])('pending trailing work is canceled on %s replacement', async cause => {
  const view = show(); await tick(); await tick(100);
  view.rerender({ viewer: 'viewer-1', room: { ...roomFixture(), revision: 2 }, enabled: true });
  if (cause === 'unmount') view.unmount();
  else if (cause === 'account') act(() => { advanceAccountEpoch(); });
  else {
    const room = roomFixture();
    if (cause === 'room') room.roomId = 'room-b';
    if (cause === 'epoch') room.epoch = 2;
    if (cause === 'member') room.self.memberId = 'new-member';
    view.rerender({ viewer: 'viewer-1', room, enabled: cause !== 'disabled' });
  }
  await tick(); const calls = mocks.get.mock.calls.length; await tick(1000); expect(mocks.get).toHaveBeenCalledTimes(calls);
  if (['room', 'epoch', 'member'].includes(cause)) expect(calls).toBe(2); else expect(calls).toBe(1);
});
