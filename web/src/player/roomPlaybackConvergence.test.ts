import { createRoomPlaybackController, type RoomPlaybackState } from './roomPlayback';
import type { PlayerAudio, PlayerQueueItem } from './types';

const attachments: Array<ReturnType<typeof createRoomPlaybackController>['attachment']> = [];

/** Native seek completion and decoder clock advancement are independently controlled. */
const setup = async () => {
  let source = 0;
  let clockOffset = 0;
  const target = { src: '/pinned.mp3', currentSrc: '/pinned.mp3', currentTime: 20, duration: 120,
    readyState: 4, seeking: false as boolean, paused: true as boolean, ended: false as boolean, error: null as { code: number } | null,
    volume: 1, muted: false, playbackRate: 1, play: vi.fn(async () => { target.paused = false; }),
    pause: vi.fn(() => { target.paused = true; }), load: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() } satisfies PlayerAudio;
  const seek = vi.fn((position: number) => { target.currentTime = position; target.seeking = true; return true; });
  const install = vi.fn(async (queue: readonly PlayerQueueItem[], index: number) => {
    source += 1; target.src = queue[index].streamUrl; target.currentSrc = target.src;
  });
  const onIntent = vi.fn();
  const controller = createRoomPlaybackController({ media: () => target, sourceGeneration: () => source,
    install, updateQueue: vi.fn(), play: target.play, pause: target.pause, seek, detach: vi.fn() },
  { now: () => 10000 + performance.now() + clockOffset, onIntent });
  const room = controller.attachment;
  attachments.push(room);
  const state: RoomPlaybackState = { roomId: 'room', epoch: 1, mediaRevision: 'mr_a', revision: 1,
    playbackEpoch: 1, controlEpoch: 1, queueRevision: 1, canControl: false, playbackAllowed: true,
    entryIds: ['entry-a'], queue: [{ id: 'a', title: 'Audio', artistNames: [], artworkUrl: '', mediaType: 'audio', streamUrl: '/pinned.mp3' }],
    currentEntryId: 'entry-a', positionSeconds: 20, status: 'playing', anchorMonotonicMs: 10000 };
  await room.apply(state);
  const emit = (event: string) => controller.observe(event, target);
  const seeked = () => { target.seeking = false; emit('seeked'); };
  const advance = async (milliseconds: number, mediaSeconds = 0) => {
    await vi.advanceTimersByTimeAsync(milliseconds);
    target.currentTime += mediaSeconds;
    emit('timeupdate');
  };
  return { room, target, state, seek, install, onIntent, emit, seeked, advance,
    replacePhysicalSource: () => { source += 1; }, delayTimerDispatch: (milliseconds: number) => { clockOffset += milliseconds; } };
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => { attachments.splice(0).forEach(room => room.detach()); vi.useRealTimers(); });

test('measures correction latency independently of startup and permits one compensated seek without command echo', async () => {
  const { room, target, seek, seeked, advance, emit, onIntent } = await setup();
  await advance(1500); // Initial play latency is not a seek measurement.
  expect(room.correct(21.5)).toBe('seek');
  seeked(); emit('timeupdate'); // Same-tick seek completion cannot be confused with advancement.
  await advance(1000);
  expect(seek).toHaveBeenCalledTimes(1);
  await advance(100, 0.1);
  expect(seek).toHaveBeenCalledTimes(2);
  expect(seek).toHaveBeenLastCalledWith(23.6); // Current authority 22.6 + measured seek cost 1, not initial startup 1.5.
  seeked();
  await advance(1000);
  await advance(100, 0.1);
  expect(target.currentTime).toBeCloseTo(23.7);
  expect(seek).toHaveBeenCalledTimes(2);
  expect(target.play).toHaveBeenCalledTimes(1);
  expect(onIntent).not.toHaveBeenCalled();
});

test('an instant seek after slow startup learns no predictive lead or automatic retry', async () => {
  const { room, target, seek, seeked, advance } = await setup();
  await advance(1500);
  expect(room.correct(21.5)).toBe('seek');
  seeked(); await advance(100, 0.1);
  expect(seek).toHaveBeenCalledTimes(1);
  await advance(1000, 1);
  expect(room.correct(25)).toBe('seek');
  expect(target.currentTime).toBe(25);
});

test('a no-op heartbeat still supplies the authoritative clock for first progress', async () => {
  const { room, target, seek, advance, emit } = await setup();
  await advance(2000);
  target.currentTime = 20.1;
  expect(room.correct(20.1)).toBe('none');
  emit('timeupdate');
  expect(seek).not.toHaveBeenCalled(); // The initial cached anchor would incorrectly target 22 here.
  expect(target.currentTime).toBe(20.1);
  await advance(500, 0.5);
  expect(seek).not.toHaveBeenCalled();
});

test('first progress projects a fresh rate-correction heartbeat instead of the older apply anchor', async () => {
  const { room, target, seek, advance } = await setup();
  await advance(2000);
  expect(room.correct(20.3)).toBe('rate');
  await advance(100, 0.105);
  expect(seek).not.toHaveBeenCalled(); // Fresh authority is 20.4; the cached anchor would incorrectly hard-seek to 22.1.
  expect(target.currentTime).toBeCloseTo(20.105);
  expect(target.playbackRate).toBe(1.05);
});

test('resync discards a previous effect\'s heartbeat clock reference', async () => {
  const { room, target, seek, seeked, advance } = await setup();
  await advance(2000);
  target.currentTime = 20.1;
  room.correct(20.1);
  room.pauseLocally(); await room.resync(); seeked();
  expect(target.currentTime).toBe(22);
  await advance(1000); await advance(100, 0.1);
  expect(seek).toHaveBeenLastCalledWith(23.1); // A new playback effect uses its own anchor, not the old heartbeat estimate.
});

test('pending heartbeat corrections refresh the latest authority without writes or double-counting predictive lead', async () => {
  const { room, target, seek, seeked, advance } = await setup();
  expect(room.correct(21)).toBe('seek');
  await advance(400);
  expect(room.correct(30)).toBe('none'); // A clock-offset refinement arrives while the native seek is pending.
  expect(seek).toHaveBeenCalledTimes(1);
  seeked();
  await advance(600);
  expect(room.correct(30.6)).toBe('none');
  await advance(100, 0.1);
  expect(seek).toHaveBeenCalledTimes(2);
  expect(target.currentTime).toBeCloseTo(31.7); // Latest raw authority 30.7 + one measured second.
  await advance(200);
  expect(room.correct(30.9)).toBe('none');
  seeked(); await advance(800); await advance(100, 0.1);
  expect(seek).toHaveBeenCalledTimes(2);
  expect(target.currentTime).toBeCloseTo(31.8);
  await advance(500, 0.5);
  expect(room.correct(33)).toBe('seek');
  expect(target.currentTime).toBeCloseTo(34); // Ordinary heartbeats retain, but do not accumulate, the learned delay.
});

test('a short first seek followed by stable longer seeks converges within two measured follow-ups', async () => {
  const { room, target, seek, seeked, advance, emit, onIntent } = await setup();
  room.correct(21); seeked(); await advance(650); await advance(100, 0.1);
  expect(seek).toHaveBeenCalledTimes(2);
  expect(target.currentTime).toBeCloseTo(22.4); // Current authority21.75 + measured0.65s.
  seeked(); await advance(1900); await advance(100, 0.1);
  expect(seek).toHaveBeenCalledTimes(3);
  expect(target.currentTime).toBeCloseTo(25.65); // New authority23.75 + remeasured1.9s, not the earlier0.65s.
  seeked(); await advance(1900); await advance(100, 0.1);
  expect(target.currentTime).toBeCloseTo(25.75);
  expect(seek).toHaveBeenCalledTimes(3);
  for (const event of ['seeked', 'playing', 'canplay', 'timeupdate']) emit(event);
  await advance(500, 0.5);
  expect(target.currentTime).toBeCloseTo(26.25);
  expect(seek).toHaveBeenCalledTimes(3);
  expect(onIntent).not.toHaveBeenCalled();
});

test('continually changing latency stops automatic correction after two follow-ups while retaining latest learning', async () => {
  const { room, state, target, seek, seeked, advance, emit } = await setup();
  room.correct(21); seeked(); await advance(650); await advance(100, 0.1);
  expect(seek).toHaveBeenCalledTimes(2);
  seeked(); await advance(1900); await advance(100, 0.1);
  expect(seek).toHaveBeenCalledTimes(3);
  seeked(); await advance(500); await advance(100, 0.1); // Even another large residual cannot create a fourth automatic seek.
  expect(seek).toHaveBeenCalledTimes(3);
  await room.apply({ ...state, revision: 2, controlEpoch: 2, queueRevision: 2 });
  for (const event of ['seeked', 'playing', 'canplay', 'timeupdate']) emit(event);
  expect(seek).toHaveBeenCalledTimes(3);
  expect(room.correct(30)).toBe('seek');
  expect(target.currentTime).toBeCloseTo(30.5);
  seeked(); await advance(1000); await advance(100, 0.1);
  expect(seek).toHaveBeenCalledTimes(4); // Ordinary heartbeats remain possible; they do not refill the automatic budget.
});

test.each(['local pause', 'shared pause', 'permission loss', 'source change', 'physical source change', 'detach', 'native pause'] as const)(
  '%s fences late convergence callbacks', async cancellation => {
    const { room, state, target, seek, seeked, advance, emit, replacePhysicalSource, onIntent } = await setup();
    room.correct(21); seeked(); await advance(500);
    if (cancellation === 'local pause') room.pauseLocally();
    if (cancellation === 'shared pause') await room.apply({ ...state, revision: 2, playbackEpoch: 2, status: 'paused' });
    if (cancellation === 'permission loss') await room.apply({ ...state, revision: 2, playbackAllowed: false });
    if (cancellation === 'source change') await room.apply({ ...state, revision: 2, playbackEpoch: 2, mediaRevision: 'mr_b',
      status: 'preparing', playbackAllowed: false, queue: [{ ...state.queue[0], streamUrl: '/replacement.mp3' }] });
    if (cancellation === 'physical source change') replacePhysicalSource();
    if (cancellation === 'detach') room.detach();
    if (cancellation === 'native pause') { target.paused = true; emit('pause'); }
    const count = seek.mock.calls.length;
    target.paused = false; seeked(); await advance(500, 0.1); await advance(3000, 0.1);
    expect(seek).toHaveBeenCalledTimes(count);
    expect(onIntent).not.toHaveBeenCalled();
  }
);

test('explicit resync clears learned delay but does not refill the same occurrence recovery budget', async () => {
  const { room, seek, seeked, advance, target } = await setup();
  room.correct(21); seeked(); await advance(650); await advance(100, 0.1);
  seeked(); await advance(1900); await advance(100, 0.1);
  seeked(); await advance(1900); await advance(100, 0.1);
  room.pauseLocally(); await room.resync(); seeked();
  const count = seek.mock.calls.length;
  expect(room.correct(30)).toBe('seek');
  expect(target.currentTime).toBe(30); // Learning belongs to the cancelled playback effect.
  seeked(); await advance(1000); await advance(100, 0.1);
  expect(seek).toHaveBeenCalledTimes(count + 1);
});

test('a new occurrence receives its own bounded compensation opportunity', async () => {
  const { room, state, seek, seeked, advance } = await setup();
  room.correct(21); seeked(); await advance(1000); await advance(100, 0.1);
  await room.apply({ ...state, revision: 2, playbackEpoch: 2, positionSeconds: 40, anchorMonotonicMs: 10000 + performance.now() });
  seeked();
  const count = seek.mock.calls.length;
  room.correct(41); seeked(); await advance(1000); await advance(100, 0.1);
  expect(seek).toHaveBeenCalledTimes(count + 2);
});

test('measurement expires without seeking and late completion cannot rearm it', async () => {
  const { room, seek, seeked, advance, target } = await setup();
  room.correct(21); seeked(); await advance(3000);
  seeked(); await advance(100, 0.1);
  expect(seek).toHaveBeenCalledTimes(1);
  expect(room.correct(25)).toBe('seek');
  expect(target.currentTime).toBe(25);
  seeked(); await advance(1000); await advance(100, 0.1);
  expect(seek).toHaveBeenCalledTimes(3); // Expiry did not consume an extra attempt that never happened.
});

test.each(['timeupdate', 'heartbeat'] as const)('a late %s enforces observation expiry before its timer callback runs', async event => {
  const { room, target, seek, seeked, emit, delayTimerDispatch } = await setup();
  room.correct(21); seeked();
  delayTimerDispatch(3100);
  target.currentTime = 22.5; // Computed seek latency is still under 2 seconds; only the real deadline makes this stale.
  if (event === 'timeupdate') {
    emit('timeupdate');
    expect(seek).toHaveBeenCalledTimes(1);
  } else {
    expect(room.correct(30)).toBe('seek');
    expect(seek).toHaveBeenCalledTimes(2);
    expect(target.currentTime).toBe(30); // A fresh heartbeat starts its own ordinary correction without stale learning.
  }
});

test('duplicate seeked events cannot reset a completed measurement baseline', async () => {
  const { room, target, seek, seeked, emit } = await setup();
  room.correct(21); seeked();
  await vi.advanceTimersByTimeAsync(1100);
  target.currentTime += 0.2;
  seeked(); emit('timeupdate');
  expect(seek).toHaveBeenCalledTimes(2);
  expect(target.currentTime).toBeCloseTo(23);
});

test('rejected compensated seeks still consume both available attempts before writing', async () => {
  const { room, seek, seeked, advance } = await setup();
  room.correct(21); seeked();
  seek.mockReturnValueOnce(false);
  await advance(1000); await advance(100, 0.1);
  expect(seek).toHaveBeenCalledTimes(2);
  room.correct(30); seeked(); seek.mockReturnValueOnce(false);
  await advance(1600); await advance(100, 0.1);
  expect(seek).toHaveBeenCalledTimes(4);
  room.correct(40); seeked(); await advance(1000); await advance(100, 0.1);
  expect(seek).toHaveBeenCalledTimes(5);
});

test('the six-second automatic window survives resync even when one attempt remains unused', async () => {
  const { room, target, seek, seeked, advance } = await setup();
  room.correct(21); seeked(); await advance(1000); await advance(100, 0.1);
  seeked(); await advance(1000); await advance(100, 0.1);
  expect(seek).toHaveBeenCalledTimes(2); // A stable first retry left one unused opportunity.
  room.pauseLocally(); await advance(5000);
  await room.resync(); seeked();
  const count = seek.mock.calls.length;
  expect(room.correct(40)).toBe('seek');
  expect(target.currentTime).toBe(40);
  seeked(); await advance(650); await advance(100, 0.1);
  expect(seek).toHaveBeenCalledTimes(count + 1); // No late automatic retry or new recovery window.
});

test('a late second follow-up observes only the remaining six-second window', async () => {
  const { room, target, seek, seeked, advance } = await setup();
  room.correct(21); seeked(); await advance(1000); await advance(100, 0.1); // Recovery window starts at1100ms.
  seeked(); await advance(1000); await advance(100, 0.1);
  await advance(3700, 3.7);
  room.correct(30); seeked(); await advance(500); await advance(100, 0.1); // Last automatic attempt starts at6500ms.
  expect(seek).toHaveBeenCalledTimes(4);
  seeked(); await advance(1000); await advance(100, 0.1); // Completion at7600ms is after the7100ms occurrence deadline.
  expect(seek).toHaveBeenCalledTimes(4);
  room.correct(40);
  expect(target.currentTime).toBe(40); // Expired observation cannot retain a late measured latency.
});

test.each(['not ready', 'permission loss', 'source change', 'local pause', 'seeking'] as const)(
  'rate deadline fences %s and restores only the current source', async condition => {
    const { room, state, target, seek, advance, emit, replacePhysicalSource } = await setup();
    await advance(100, 0.1); // Finish the original startup observer before exercising the independent rate deadline.
    expect(room.correct(20.4)).toBe('rate');
    if (condition === 'not ready') target.readyState = 2;
    if (condition === 'permission loss') await room.apply({ ...state, revision: 2, playbackAllowed: false });
    if (condition === 'source change') {
      replacePhysicalSource();
      target.playbackRate = 0.95; // An old deadline cannot mutate a replacement source's rate.
    }
    if (condition === 'local pause') room.pauseLocally();
    if (condition === 'seeking') { target.seeking = true; emit('seeking'); }
    const count = seek.mock.calls.length;
    await advance(4000);
    expect(seek).toHaveBeenCalledTimes(count);
    expect(target.playbackRate).toBe(condition === 'source change' ? 0.95 : 1);
  }
);

test('a rate reset that synchronously loses readiness cannot seek from the old ready state', async () => {
  const { room, target, seek, advance } = await setup();
  await advance(100, 0.1);
  expect(room.correct(20.4)).toBe('rate');
  let rate = target.playbackRate;
  Object.defineProperty(target, 'playbackRate', { get: () => rate, set: (value: number) => { rate = value; target.readyState = 2; } });
  await advance(4000);
  expect(rate).toBe(1);
  expect(seek).not.toHaveBeenCalled();
});

test.each([20.4, 21])('direct correction to %s rechecks readiness after restoring rate', async position => {
  const { room, target, seek, advance } = await setup();
  await advance(100, 0.1);
  let rate = 1.05;
  const writeRate = vi.fn((value: number) => { rate = value; target.readyState = 2; });
  Object.defineProperty(target, 'playbackRate', { get: () => rate, set: writeRate });
  expect(room.correct(position)).toBe('none');
  expect(writeRate).toHaveBeenCalledExactlyOnceWith(1);
  expect(seek).not.toHaveBeenCalled();
});

test.each(['error', 'ended'] as const)('%s prevents rate-deadline seek even when the element remains ready and unpaused', async event => {
  const { room, target, seek, advance, emit } = await setup();
  await advance(100, 0.1);
  expect(room.correct(20.4)).toBe('rate');
  if (event === 'error') target.error = { code: 3 };
  else target.ended = true;
  emit(event);
  await advance(4000);
  expect(target.readyState).toBe(4);
  expect(target.paused).toBe(false);
  expect(target.playbackRate).toBe(1);
  expect(seek).not.toHaveBeenCalled();
});

test.each(['error', 'ended'] as const)('%s prevents both soft-rate and hard direct correction', async event => {
  const { room, target, seek, advance, emit } = await setup();
  await advance(100, 0.1);
  if (event === 'error') target.error = { code: 3 };
  else target.ended = true;
  emit(event);
  expect(room.correct(20.4)).toBe('none');
  expect(room.correct(22)).toBe('none');
  expect(target.playbackRate).toBe(1);
  expect(seek).not.toHaveBeenCalled();
});

test('already-normal rate is not reassigned by no-op heartbeat corrections', async () => {
  const { room, target, advance } = await setup();
  await advance(100, 0.1);
  const writeRate = vi.fn();
  Object.defineProperty(target, 'playbackRate', { get: () => 1, set: writeRate });
  expect(room.correct(20.1)).toBe('none');
  expect(room.correct(20.2)).toBe('none');
  expect(writeRate).not.toHaveBeenCalled();
});

test.each(['excessive delay', 'clock jump', 'changed rate', 'inaccurate seek', 'near end'] as const)(
  '%s cannot produce a latency-compensated follow-up', async condition => {
    const { room, target, seek, seeked, advance } = await setup();
    if (condition === 'near end') target.duration = 22.5;
    room.correct(21);
    if (condition === 'inaccurate seek') target.currentTime += 1;
    seeked();
    if (condition === 'changed rate') target.playbackRate = 1.05;
    await advance(condition === 'excessive delay' ? 2100 : 1000);
    await advance(100, condition === 'clock jump' ? 5 : 0.1);
    expect(seek).toHaveBeenCalledTimes(1);
  }
);
