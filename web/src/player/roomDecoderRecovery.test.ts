import { createRoomPlaybackController, type RoomPlaybackState } from './roomPlayback';
import type { PlayerAudio, PlayerQueueItem } from './types';

/** A stalled paused decoder exposes current data but never enough future data until a source reload. */
const setup = () => {
  let source = 0;
  const target = { src: '/pinned.mp3', currentSrc: '/pinned.mp3', currentTime: 0, duration: 120,
    readyState: 0, seeking: false, paused: true as boolean, ended: false, error: null as { code: number } | null,
    buffered: { length: 1, start: () => 0, end: () => 120 }, volume: 1, muted: false, playbackRate: 1,
    play: vi.fn(async () => { target.paused = false; }), pause: vi.fn(() => { target.paused = true; }),
    load: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() } satisfies PlayerAudio;
  const install = vi.fn(async (queue: readonly PlayerQueueItem[], index: number) => {
    source += 1; target.src = queue[index].streamUrl; target.currentSrc = target.src;
    target.currentTime = 0; target.readyState = 0;
  });
  const onIntent = vi.fn(), onObservation = vi.fn();
  const controller = createRoomPlaybackController({ media: () => target, sourceGeneration: () => source, install,
    updateQueue: vi.fn(), play: target.play, pause: target.pause,
    seek: position => { target.currentTime = position; return true; }, detach: vi.fn() },
  { now: () => 10000 + performance.now(), onIntent, onObservation });
  const state: RoomPlaybackState = { roomId: 'room', epoch: 1, mediaRevision: 'mr_a', revision: 1,
    playbackEpoch: 1, controlEpoch: 1, queueRevision: 1, canControl: true, playbackAllowed: false,
    entryIds: ['entry-a'], queue: [{ id: 'a', title: 'Audio', artistNames: [], artworkUrl: '', mediaType: 'audio', streamUrl: '/pinned.mp3' }],
    currentEntryId: 'entry-a', positionSeconds: 66, status: 'preparing', anchorMonotonicMs: 10000 };
  const decoded = (readyState: number) => {
    target.readyState = readyState;
    controller.observe('loadedmetadata', target);
    controller.observe('seeked', target);
  };
  return { target, install, onIntent, onObservation, controller, room: controller.attachment, state, decoded };
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test('a stalled fully buffered decoder reloads once, stays paused and still requires real readiness', async () => {
  const { room, state, target, install, decoded, onObservation, onIntent } = setup();
  await room.apply(state); decoded(2);
  await vi.advanceTimersByTimeAsync(999); expect(install).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); expect(install).toHaveBeenCalledTimes(2);
  expect(target.play).not.toHaveBeenCalled();
  decoded(2);
  await room.apply({ ...state, revision: 2, playbackAllowed: true });
  await vi.advanceTimersByTimeAsync(5000);
  expect(install).toHaveBeenCalledTimes(2);
  expect(onObservation.mock.calls.some(([event]) => event.type === 'ready')).toBe(false);
  decoded(4);
  expect(target.currentTime).toBe(66);
  expect(onObservation).toHaveBeenCalledWith(expect.objectContaining({ type: 'ready', playbackEpoch: 1 }));
  expect(target.play).not.toHaveBeenCalled();
  expect(onIntent).not.toHaveBeenCalled();
  room.detach();
});

test.each(['local-pause', 'detach', 'replacement', 'ready'] as const)('%s cancels pending decoder recovery', async action => {
  const { room, state, target, install, decoded } = setup();
  await room.apply(state); decoded(2);
  if (action === 'local-pause') room.pauseLocally();
  if (action === 'detach') room.detach();
  if (action === 'replacement') await room.apply({ ...state, revision: 2, playbackEpoch: 2, mediaRevision: 'mr_b',
    queue: [{ ...state.queue[0], streamUrl: '/replacement.mp3' }] });
  if (action === 'ready') decoded(4);
  const count = install.mock.calls.length;
  await vi.advanceTimersByTimeAsync(5000);
  expect(install).toHaveBeenCalledTimes(count);
  expect(target.play).not.toHaveBeenCalled();
  room.detach();
});

test.each(['partial-buffer', 'near-end', 'metadata-only', 'error', 'video'] as const)('%s cannot trigger paused decoder recovery', async condition => {
  const { room, state, target, install, decoded } = setup();
  const incoming = condition === 'video' ? { ...state, queue: [{ ...state.queue[0], mediaType: 'video' as const }] }
    : condition === 'near-end' ? { ...state, positionSeconds: 119.8 } : state;
  await room.apply(incoming);
  if (condition === 'partial-buffer') target.buffered.end = () => 80;
  if (condition === 'error') target.error = { code: 3 };
  decoded(condition === 'metadata-only' ? 1 : 2);
  await vi.advanceTimersByTimeAsync(5000);
  expect(install).toHaveBeenCalledTimes(1);
  expect(target.play).not.toHaveBeenCalled();
  room.detach();
});

test('a new occurrence has its own single recovery opportunity', async () => {
  const { room, state, install, decoded } = setup();
  await room.apply(state); decoded(2);
  await vi.advanceTimersByTimeAsync(1000); decoded(2);
  await room.apply({ ...state, revision: 2, playbackEpoch: 2, positionSeconds: 88 });
  await vi.advanceTimersByTimeAsync(1000);
  expect(install).toHaveBeenCalledTimes(3);
  room.detach();
});

test('failed decoder reload remains unready without an automatic retry loop', async () => {
  const { room, state, install, decoded, onObservation, target } = setup();
  await room.apply(state); decoded(2);
  install.mockRejectedValueOnce(new Error('Source unavailable'));
  await vi.advanceTimersByTimeAsync(5000); decoded(4);
  expect(install).toHaveBeenCalledTimes(2);
  expect(onObservation.mock.calls.some(([event]) => event.type === 'ready')).toBe(false);
  expect(target.play).not.toHaveBeenCalled();
  room.detach();
});

test('pause during reload cannot resume playback, while explicit resync uses the installed source', async () => {
  const { room, state, install, decoded, target } = setup();
  await room.apply(state); decoded(2);
  let finish!: () => void;
  install.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  await vi.advanceTimersByTimeAsync(1000);
  room.pauseLocally(); finish(); await Promise.resolve(); await Promise.resolve();
  decoded(4);
  expect(target.play).not.toHaveBeenCalled();
  await room.resync();
  expect(target.currentTime).toBe(66);
  expect(target.play).not.toHaveBeenCalled();
  room.detach();
});

test('reload fences old callbacks and seeks to the latest same-occurrence server anchor', async () => {
  const { room, state, install, decoded, target, onObservation } = setup();
  await room.apply(state); decoded(2);
  let finish!: () => void;
  const loading = new Promise<void>(resolve => { finish = resolve; });
  const installSource = install.getMockImplementation()!;
  install.mockImplementationOnce(async (...args) => { await installSource(...args); await loading; });
  await vi.advanceTimersByTimeAsync(1000);
  decoded(4);
  expect(onObservation.mock.calls.some(([event]) => event.type === 'ready')).toBe(false);
  await room.apply({ ...state, revision: 2, status: 'playing' });
  await vi.advanceTimersByTimeAsync(500);
  finish(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  decoded(4);
  expect(target.currentTime).toBe(67.5);
  expect(onObservation).toHaveBeenCalledWith(expect.objectContaining({ type: 'ready', playbackEpoch: 1 }));
  expect(target.play).not.toHaveBeenCalled();
  room.detach();
});

test('an older pending reload cannot ready or reposition a replacement occurrence', async () => {
  const { room, state, install, decoded, target, onObservation } = setup();
  await room.apply(state); decoded(2);
  let finish!: () => void;
  const loading = new Promise<void>(resolve => { finish = resolve; });
  const installSource = install.getMockImplementation()!;
  install.mockImplementationOnce(async (...args) => { await installSource(...args); await loading; });
  await vi.advanceTimersByTimeAsync(1000);
  await room.apply({ ...state, revision: 2, playbackEpoch: 2, mediaRevision: 'mr_b', positionSeconds: 88,
    queue: [{ ...state.queue[0], streamUrl: '/replacement.mp3' }] });
  decoded(4);
  finish(); await Promise.resolve(); await Promise.resolve();
  expect(target.currentTime).toBe(88);
  expect(target.src).toBe('/replacement.mp3');
  expect(onObservation.mock.calls.filter(([event]) => event.type === 'ready').map(([event]) => event.playbackEpoch)).toEqual([2]);
  expect(target.play).not.toHaveBeenCalled();
  room.detach();
});
