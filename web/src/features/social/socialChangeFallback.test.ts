import { ApiError } from '../../api/client';

const mocks = vi.hoisted(() => ({ getSocialChangeRevision: vi.fn() }));
vi.mock('../../api/socialChanges', () => ({ getSocialChangeRevision: mocks.getSocialChangeRevision }));
import { createSocialChangeFallback, socialChangePollMs } from './socialChangeFallback';

let hidden = false;
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); hidden = false;
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  mocks.getSocialChangeRevision.mockResolvedValue({ revision: 4 });
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

/** Mirrors the room session's five-second heartbeat, which is the only caller of `tick`. */
const heartbeats = async (fallback: ReturnType<typeof createSocialChangeFallback>, count: number) => {
  for (let index = 0; index < count; index += 1) {
    await vi.advanceTimersByTimeAsync(5_000);
    await fallback.tick();
  }
};

test('the first poll refreshes once, then idle polls back off to one per minute without refreshing', async () => {
  const changed = vi.fn();
  const fallback = createSocialChangeFallback('viewer-1', () => true, changed);
  await fallback.tick();
  expect(mocks.getSocialChangeRevision).toHaveBeenCalledExactlyOnceWith('viewer-1');
  expect(changed).toHaveBeenCalledOnce();
  // Unchanged polls wait 15, 30, then 60 seconds, and stay at 60.
  const pollTimes: number[] = [];
  mocks.getSocialChangeRevision.mockImplementation(async () => { pollTimes.push(Date.now()); return { revision: 4 }; });
  const start = Date.now();
  await heartbeats(fallback, 48);
  expect(pollTimes.map(time => time - start)).toEqual([15_000, 45_000, 105_000, 165_000, 225_000]);
  expect(changed).toHaveBeenCalledOnce();
  expect(socialChangePollMs).toEqual({ base: 15_000, maximum: 60_000 });
});

test('a changed revision refreshes and restores the fast cadence', async () => {
  const changed = vi.fn();
  const fallback = createSocialChangeFallback('viewer-1', () => true, changed);
  await fallback.tick();
  await heartbeats(fallback, 9);
  expect(mocks.getSocialChangeRevision).toHaveBeenCalledTimes(3);
  mocks.getSocialChangeRevision.mockResolvedValue({ revision: 5 });
  await heartbeats(fallback, 12);
  expect(mocks.getSocialChangeRevision).toHaveBeenCalledTimes(4);
  expect(changed).toHaveBeenCalledTimes(2);
  await heartbeats(fallback, 3);
  expect(mocks.getSocialChangeRevision).toHaveBeenCalledTimes(5);
  // Inequality, not ordering, signals a change: a reset counter still refreshes.
  mocks.getSocialChangeRevision.mockResolvedValue({ revision: 1 });
  await heartbeats(fallback, 6);
  expect(changed).toHaveBeenCalledTimes(3);
});

test('failed polls back off without refreshing and keep the last successful baseline', async () => {
  const changed = vi.fn();
  const fallback = createSocialChangeFallback('viewer-1', () => true, changed);
  await fallback.tick();
  mocks.getSocialChangeRevision.mockRejectedValue(new ApiError('Too many requests.', 'http', 429));
  await heartbeats(fallback, 3);
  await heartbeats(fallback, 6);
  expect(mocks.getSocialChangeRevision).toHaveBeenCalledTimes(3);
  expect(changed).toHaveBeenCalledOnce();
  // The next attempt waits the doubled delay; an unchanged recovery still refreshes nothing.
  mocks.getSocialChangeRevision.mockResolvedValue({ revision: 4 });
  await heartbeats(fallback, 11);
  expect(mocks.getSocialChangeRevision).toHaveBeenCalledTimes(3);
  await heartbeats(fallback, 1);
  expect(mocks.getSocialChangeRevision).toHaveBeenCalledTimes(4);
  expect(changed).toHaveBeenCalledOnce();
});

test('a hidden tab never polls and returning to it polls promptly at the fast cadence', async () => {
  const changed = vi.fn();
  const fallback = createSocialChangeFallback('viewer-1', () => true, changed);
  hidden = true;
  await heartbeats(fallback, 24);
  expect(mocks.getSocialChangeRevision).not.toHaveBeenCalled();
  hidden = false;
  await fallback.tick();
  expect(changed).toHaveBeenCalledOnce();
  await heartbeats(fallback, 9);
  expect(mocks.getSocialChangeRevision).toHaveBeenCalledTimes(3);
  hidden = true;
  await heartbeats(fallback, 1);
  hidden = false;
  mocks.getSocialChangeRevision.mockResolvedValue({ revision: 6 });
  // The idle backoff was 60 seconds; the first visible heartbeat polls immediately instead.
  await heartbeats(fallback, 1);
  expect(mocks.getSocialChangeRevision).toHaveBeenCalledTimes(4);
  expect(changed).toHaveBeenCalledTimes(2);
});

test('overlapping heartbeats share one request and a replaced account ignores the late result', async () => {
  let resolve!: (value: { revision: number }) => void;
  mocks.getSocialChangeRevision.mockReturnValueOnce(new Promise(done => { resolve = done; }));
  let active = true;
  const changed = vi.fn();
  const fallback = createSocialChangeFallback('viewer-1', () => active, changed);
  const first = fallback.tick();
  await fallback.tick();
  expect(mocks.getSocialChangeRevision).toHaveBeenCalledOnce();
  active = false;
  resolve({ revision: 9 });
  await first;
  expect(changed).not.toHaveBeenCalled();
  await heartbeats(fallback, 24);
  expect(mocks.getSocialChangeRevision).toHaveBeenCalledOnce();
});
