import { createRoomPlaybackController, type RoomPlaybackState } from './roomPlayback';
import type { PlayerAudio, PlayerQueueItem } from './types';

const attachments: Array<ReturnType<typeof createRoomPlaybackController>['attachment']> = [];

/** Native seek completion and decoder clock advancement are independently controlled. */
const setup = async () => {
  let source = 0;
  let clockOffset = 0;
  const target = { src: '/pinned.mp3', currentSrc: '/pinned.mp3', currentTime: 20, duration: 120,
    readyState: 4, seeking: false as boolean, paused: true as boolean, ended: false, error: null as { code: number } | null,
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

test('compensation completion updates latency but cannot automatically issue a third seek', async () => {
  const { room, state, target, seek, seeked, advance, emit } = await setup();
  room.correct(21); seeked(); await advance(1000); await advance(100, 0.1);
  expect(seek).toHaveBeenCalledTimes(2);
  seeked(); await advance(1600); await advance(100, 0.1); // The second decoder delay differs.
  expect(seek).toHaveBeenCalledTimes(2);
  await room.apply({ ...state, revision: 2, controlEpoch: 2, queueRevision: 2 });
  for (const event of ['seeked', 'playing', 'canplay', 'timeupdate']) emit(event);
  expect(seek).toHaveBeenCalledTimes(2);
  expect(room.correct(30)).toBe('seek');
  expect(target.currentTime).toBeCloseTo(31.6);
  seeked(); await advance(1000); await advance(100, 0.1);
  expect(seek).toHaveBeenCalledTimes(3); // The occurrence budget is still spent even when drift remains.
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
  room.correct(21); seeked(); await advance(1000); await advance(100, 0.1);
  seeked(); await advance(1000); await advance(100, 0.1);
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

test('a rejected compensated seek still consumes its occurrence budget', async () => {
  const { room, seek, seeked, advance } = await setup();
  room.correct(21); seeked();
  seek.mockReturnValueOnce(false);
  await advance(1000); await advance(100, 0.1);
  expect(seek).toHaveBeenCalledTimes(2);
  room.correct(30); seeked(); await advance(1600); await advance(100, 0.1);
  expect(seek).toHaveBeenCalledTimes(3);
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
