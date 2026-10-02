import trace from '../../../contracts/social/prototype-v1/playback-trace.json';
import { createPlayerStore } from './playerStore';
import type { PlayerAudio, PlayerMediaSession, PlayerMediaSessionAction, PlayerMediaSessionActionDetails, PlayerQueueItem } from './types';
import type { RoomPlaybackOptions, RoomPlaybackState } from './roomPlayback';
import { createRoomPlaybackController } from './roomPlayback';
import { createActualPlaybackObserver, type ActualPlaybackObservation } from './actualPlayback';
import { advanceAccountEpoch, subscribeToAccountEpoch } from '../api/accountEpoch';

/** Explicit browser state controls distinguish metadata, seek completion, and actual start. */
class RoomAudio implements PlayerAudio {
  src = '';
  currentSrc = '';
  currentTime = 0;
  duration = 2;
  volume = 1;
  muted = false;
  paused = true;
  ended = false;
  error: { code: number } | null = null;
  playbackRate = 1;
  readyState = 0;
  preload = 'metadata';
  seeking = false;
  loadCalls = 0;
  playCalls = 0;
  autoStart = true;
  rejectPlay = false;
  listeners = new Map<string, Set<() => void>>();
  async play() {
    this.playCalls += 1;
    if (this.rejectPlay) throw new DOMException('Gesture needed', 'NotAllowedError');
    this.paused = false;
    this.ended = false;
    this.emit('play');
    if (this.autoStart) this.emit('playing');
  }
  pause() { this.paused = true; this.emit('pause'); }
  load() { this.loadCalls += 1; this.readyState = 0; this.currentSrc = ''; this.error = null; this.emit('loadstart'); }
  addEventListener(type: string, callback: () => void) {
    const callbacks = this.listeners.get(type) ?? new Set();
    callbacks.add(callback);
    this.listeners.set(type, callbacks);
  }
  removeEventListener(type: string, callback: () => void) { this.listeners.get(type)?.delete(callback); }
  removeAttribute(name: string) { if (name === 'src') this.src = ''; }
  emit(type: string) { this.listeners.get(type)?.forEach((callback) => callback()); }
  ready() { this.currentSrc = this.src; this.readyState = 4; this.emit('loadedmetadata'); this.emit('canplay'); }
}

const queue: PlayerQueueItem[] = ['a', 'b', 'c'].map((name, index) => ({
  id: `00000000000000000000000${index + 1}`, title: name, artworkUrl: '',
  artistNames: [], mediaType: 'audio', streamUrl: `/synthetic/${name}.wav`
}));

/** Maps the exact cross-client synthetic corpus into this player's local seam. */
const frame = (index: number): RoomPlaybackState => {
  const value = trace.snapshots[index].snapshot;
  return {
    roomId: value.roomId, epoch: value.epoch, mediaRevision: value.mediaRevision,
    revision: value.revision, playbackEpoch: value.playbackGeneration,
    controlEpoch: value.controlGeneration, queueRevision: value.queueRevision,
    canControl: true,
    entryIds: ['entry-a', 'entry-b', 'entry-c'], queue, currentEntryId: value.entryId,
    positionSeconds: value.positionMs / 1000, status: value.state as 'playing' | 'paused',
    anchorMonotonicMs: value.anchorServerTimeMs
  };
};

const setup = (audio = new RoomAudio(), options: Partial<RoomPlaybackOptions> = {}) => {
  const onIntent = vi.fn();
  const onObservation = vi.fn();
  const factory = vi.fn(() => audio);
  const actions = new Map<PlayerMediaSessionAction, (details: PlayerMediaSessionActionDetails) => void>();
  const mediaSession: PlayerMediaSession = {
    metadata: null, playbackState: 'none',
    setActionHandler: (action, callback) => { if (callback) actions.set(action, callback); }
  };
  const store = createPlayerStore({ audioFactory: factory, roomPlaybackProbeFactory: createRoomPlaybackController, mediaSession });
  const room = store.attachRoomPlayback({ onIntent, onObservation, now: () => 10000 + performance.now(), ...options });
  return { audio, onIntent, onObservation, factory, store, room, actions };
};

/** Visibility changes and page suspension are separate browser lifecycle signals. */
const setupLifecycle = (hidden = false) => {
  const visibility = Object.assign(new EventTarget(), { hidden });
  const pageLifecycle = new EventTarget();
  return { ...setup(undefined, { visibility, pageLifecycle }), visibility, pageLifecycle };
};

/** An explicit source installation has an independently observable physical generation and completion. */
const setupSourceRetry = () => {
  const audio = new RoomAudio(); audio.duration = 120;
  let generation = 0;
  const install = vi.fn(async (items: readonly PlayerQueueItem[], index: number) => {
    generation++; audio.src = items[index].streamUrl; audio.currentTime = 0; audio.load();
  });
  const onIntent = vi.fn(), onObservation = vi.fn();
  const port = { media: () => audio, sourceGeneration: () => generation,
    install, updateQueue: vi.fn(), play: () => audio.play(), pause: () => audio.pause(),
    seek: (position: number) => { audio.currentTime = position; return true; }, detach: vi.fn() };
  const controller = createRoomPlaybackController(port,
  { now: () => 10_000, onIntent, onObservation });
  const ready = () => {
    audio.currentSrc = audio.src; audio.readyState = 4;
    controller.observe('loadedmetadata', audio); controller.observe('canplay', audio);
  };
  return { audio, install, port, onIntent, onObservation, controller, room: controller.attachment, ready,
    changePhysicalSource: () => { generation++; } };
};

afterEach(() => vi.useRealTimers());

test('ordinary player construction requires an explicit room controller to attach', () => {
  const store = createPlayerStore({ mediaSession: null });
  expect(() => store.attachRoomPlayback({ onIntent: vi.fn() })).toThrow('authorized room controller');
  store.destroy();
});

test('room queue edits replace upcoming context without restarting the source and detach clears cached items', async () => {
  const { room, audio, store, onIntent, factory } = setup();
  const initial = { ...frame(0), status: 'paused' as const, positionSeconds: 0, anchorMonotonicMs: 10_000 };
  await room.apply(initial); audio.ready();
  const upcoming = store.getSnapshot().upNextItems;
  audio.currentTime = 0.5; audio.emit('timeupdate');
  expect(store.getSnapshot().upNextItems).toBe(upcoming);
  const loads = audio.loadCalls;
  await room.apply({ ...initial, revision: initial.revision + 1, queueRevision: initial.queueRevision + 1,
    entryIds: ['entry-a', 'entry-c', 'entry-b'], queue: [queue[0], queue[2], queue[1]] });
  expect(store.getSnapshot().upNextItems).not.toBe(upcoming);
  expect(store.getSnapshot().upNextItems.map(item => item.id)).toEqual([queue[2].id, queue[1].id]);
  expect(audio.loadCalls).toBe(loads);
  expect(onIntent).not.toHaveBeenCalled();
  room.detach();
  expect(store.getSnapshot().upNextItems).toEqual([]);
  await store.launchStandalone({ ...queue[2], mediaType: 'video' }, { autoplay: false });
  expect(store.getSnapshot().currentItem?.mediaType).toBe('video');
  expect(store.getSnapshot().upNextItems).toEqual([]);
  expect(factory).toHaveBeenCalledTimes(1);
  store.destroy();
});

test('room listening observations require actual ready playback and retain occurrence through queue-only snapshots', async () => {
  let clock = 10000;
  const { audio, room, store, onIntent } = setup(undefined, { now: () => clock });
  const observations: ActualPlaybackObservation[] = [];
  const stop = createActualPlaybackObserver(store, event => observations.push(event), { now: () => clock });
  const preparing = { ...frame(0), status: 'preparing' as const, playbackAllowed: false, anchorMonotonicMs: 10000 };
  await room.apply(preparing); audio.ready();
  expect(observations).toEqual([]);
  const playing = { ...preparing, revision: 2, status: 'playing' as const, playbackAllowed: true };
  await room.apply(playing);
  const first = observations.find(event => 'sample' in event);
  expect(first).toMatchObject({ type: 'playing', sample: { intentId: 0, mediaTrackId: queue[0].id,
    room: { roomId: preparing.roomId, epoch: preparing.epoch, playbackEpoch: preparing.playbackEpoch, entryId: preparing.currentEntryId } } });
  await room.apply({ ...playing, revision: 3, queueRevision: 2 });
  expect(observations.filter(event => event.type === 'stopped')).toEqual([]);
  await room.apply({ ...playing, revision: 1, currentEntryId: 'entry-b' });
  clock += 500; audio.currentTime += .5; audio.emit('timeupdate');
  expect(observations.at(-1)).toMatchObject({ type: 'progress', sample: { room: { entryId: preparing.currentEntryId } } });
  expect(onIntent).not.toHaveBeenCalled();
  room.pauseLocally(); expect(observations.at(-1)?.type).toBe('stopped');
  stop(); store.destroy();
});

test('preparation completion keeps its generation and starts only at the future server anchor', async () => {
  vi.useFakeTimers();
  const { audio, room, store, onIntent } = setup();
  const preparing = { ...frame(0), status: 'preparing' as const, playbackAllowed: false };
  await room.apply(preparing); audio.ready(); await Promise.resolve();
  expect(audio.playCalls).toBe(0);
  expect(await room.apply({ ...preparing, revision: 2, status: 'playing', playbackAllowed: true, anchorMonotonicMs: 10_350 })).toBe(true);
  await vi.advanceTimersByTimeAsync(349);
  expect(audio.playCalls).toBe(0);
  await vi.advanceTimersByTimeAsync(1);
  expect(audio.playCalls).toBe(1);
  expect(audio.loadCalls).toBe(1);
  expect(onIntent).not.toHaveBeenCalled();
  store.destroy();
});

test('room preparation buffers paused media and restores ordinary preload after detaching', async () => {
  const { audio, room, store, onObservation } = setup();
  await room.apply({ ...frame(0), status: 'preparing', playbackAllowed: false });
  expect(audio.preload).toBe('auto');
  audio.currentSrc = audio.src; audio.readyState = 2; audio.emit('loadedmetadata'); audio.emit('seeked');
  expect(audio.playCalls).toBe(0);
  expect(onObservation.mock.calls.some(([value]) => value.type === 'ready')).toBe(false);
  audio.readyState = 4; audio.emit('canplay');
  expect(onObservation).toHaveBeenCalledWith(expect.objectContaining({ type: 'ready' }));
  expect(audio.playCalls).toBe(0);
  room.detach();
  await store.launchStandalone(queue[0]);
  expect(audio.preload).toBe('metadata');
  store.destroy();
});

test('readiness confirmation and scheduled start reuse the completed seek without flushing the decoder', async () => {
  vi.useFakeTimers();
  const audio = new RoomAudio(); audio.duration = 120; audio.readyState = 4;
  audio.src = queue[0].streamUrl; audio.currentSrc = audio.src;
  const seek = vi.fn((position: number) => { audio.currentTime = position; audio.seeking = true; return true; });
  const onObservation = vi.fn(), onIntent = vi.fn();
  const controller = createRoomPlaybackController({ media: () => audio, sourceGeneration: () => 1,
    install: async () => undefined, updateQueue: () => undefined, play: () => audio.play(), pause: () => audio.pause(),
    seek, detach: () => undefined }, { now: () => 10000 + performance.now(), onObservation, onIntent });
  const preparing = { ...frame(0), positionSeconds: 66, status: 'preparing' as const, playbackAllowed: false };
  await controller.attachment.apply(preparing);
  expect(seek).toHaveBeenCalledExactlyOnceWith(66);
  audio.seeking = false; controller.observe('seeked', audio);
  await controller.attachment.apply({ ...preparing, revision: 2, playbackAllowed: true });
  await controller.attachment.apply({ ...preparing, revision: 3, playbackAllowed: true, status: 'playing', anchorMonotonicMs: 10350 });
  expect(seek).toHaveBeenCalledTimes(1);
  expect(audio.playCalls).toBe(0);
  await vi.advanceTimersByTimeAsync(350);
  expect(audio.playCalls).toBe(1);
  expect(onIntent).not.toHaveBeenCalled();
  controller.attachment.detach();
});

test('the first advancing media clock corrects a delayed start once without replaying a command', async () => {
  let clock = 10_000;
  const { audio, room, store, onIntent } = setup(undefined, { now: () => clock });
  audio.duration = 120;
  await room.apply({ ...frame(0), status: 'playing', playbackAllowed: true, canControl: false,
    positionSeconds: 5, anchorMonotonicMs: clock });
  audio.ready();
  expect(audio.playCalls).toBe(1);
  clock += 1_000;
  for (const event of ['canplay', 'playing', 'seeked', 'timeupdate']) audio.emit(event);
  expect(audio.currentTime).toBe(5); // A play promise and readiness do not prove an advancing clock.
  audio.currentTime = 5.01; audio.emit('timeupdate');
  expect(audio.currentTime).toBe(5.01);
  audio.currentTime = 5.03; audio.emit('timeupdate');
  expect(audio.currentTime).toBe(6);
  clock += 1_000;
  for (const event of ['seeked', 'playing', 'canplay', 'timeupdate']) audio.emit(event);
  audio.currentTime = 6.1; audio.emit('timeupdate');
  expect(audio.currentTime).toBe(6.1); // Correction-generated events cannot start a seek loop.
  expect(audio.playCalls).toBe(1);
  expect(audio.playbackRate).toBe(1);
  expect(onIntent).not.toHaveBeenCalled();
  store.destroy();
});

test.each(['play', 'playing'] as const)('a queued %s during an owned seek does not strand the authorized player paused', async event => {
  const audio = new RoomAudio(); audio.duration = 120; audio.readyState = 4;
  audio.src = queue[0].streamUrl; audio.currentSrc = audio.src;
  const seek = vi.fn((position: number) => { audio.currentTime = position; audio.seeking = true; return true; });
  const onIntent = vi.fn();
  const controller = createRoomPlaybackController({ media: () => audio, sourceGeneration: () => 1,
    install: async () => undefined, updateQueue: () => undefined, play: () => audio.play(), pause: () => audio.pause(),
    seek, detach: () => undefined }, { now: () => 10_000, onIntent });
  await controller.attachment.apply({ ...frame(0), positionSeconds: 0, anchorMonotonicMs: 10_000,
    status: 'playing', playbackAllowed: true });
  expect(audio.playCalls).toBe(1);
  expect(controller.attachment.correct(2)).toBe('seek');
  audio.readyState = 1;
  controller.observe(event, audio); // A queued event from the previous play can arrive while the owned seek is still pending.
  expect(audio.paused).toBe(true);
  audio.seeking = false; audio.readyState = 4;
  controller.observe('seeked', audio);
  await Promise.resolve();
  expect(audio.playCalls).toBe(2);
  expect(audio.paused).toBe(false);
  controller.observe('canplay', audio);
  expect(audio.playCalls).toBe(2);
  expect(onIntent).not.toHaveBeenCalled();
  controller.attachment.detach();
});

test.each(['local pause', 'shared pause', 'permission loss', 'physical source change', 'detach'] as const)(
  '%s fences resumption after a queued playing event interrupts an owned seek', async cancellation => {
    const audio = new RoomAudio(); audio.duration = 120; audio.readyState = 4;
    audio.src = queue[0].streamUrl; audio.currentSrc = audio.src;
    let generation = 1;
    const onIntent = vi.fn();
    const controller = createRoomPlaybackController({ media: () => audio, sourceGeneration: () => generation,
      install: async () => undefined, updateQueue: () => undefined, play: () => audio.play(), pause: () => audio.pause(),
      seek: position => { audio.currentTime = position; audio.seeking = true; return true; }, detach: () => undefined },
    { now: () => 10_000, onIntent });
    const initial = { ...frame(0), positionSeconds: 0, anchorMonotonicMs: 10_000, status: 'playing' as const, playbackAllowed: true };
    await controller.attachment.apply(initial);
    controller.attachment.correct(2);
    controller.observe('playing', audio);
    if (cancellation === 'local pause') controller.attachment.pauseLocally();
    if (cancellation === 'shared pause') expect(await controller.attachment.apply({ ...initial,
      revision: initial.revision + 1, playbackEpoch: initial.playbackEpoch + 1, status: 'paused' })).toBe(true);
    if (cancellation === 'permission loss') expect(await controller.attachment.apply({ ...initial,
      revision: initial.revision + 1, playbackAllowed: false })).toBe(true);
    if (cancellation === 'physical source change') generation++;
    if (cancellation === 'detach') controller.attachment.detach();
    const before = audio.playCalls;
    audio.seeking = false; audio.readyState = 4;
    controller.observe('seeked', audio); controller.observe('canplay', audio);
    await Promise.resolve();
    expect(audio.playCalls).toBe(before);
    expect(audio.paused).toBe(true);
    expect(onIntent).not.toHaveBeenCalled();
    controller.attachment.detach();
  }
);

test('a ping correction before natural playback owns convergence without treating its time jump as progress', async () => {
  let clock = 10_000;
  const { audio, room, store, onIntent } = setup(undefined, { now: () => clock });
  audio.duration = 120;
  await room.apply({ ...frame(0), status: 'playing', playbackAllowed: true,
    positionSeconds: 5, anchorMonotonicMs: clock });
  audio.ready();
  clock += 2_000;
  expect(room.correct(7)).toBe('seek');
  audio.emit('timeupdate'); // The assigned position may be observable before native seeking callbacks.
  audio.seeking = true; audio.emit('seeking');
  clock += 500;
  audio.seeking = false; audio.emit('seeked'); audio.emit('timeupdate');
  expect(audio.currentTime).toBe(7);
  clock += 1_000;
  audio.currentTime = 7.03; audio.emit('timeupdate');
  expect(audio.currentTime).toBeCloseTo(9.97); // Authority 8.5 + the correction's measured 1.47 seconds of lost media time.
  // A changed measured latency permits one final estimate, then no completion callback can replenish the budget.
  audio.emit('seeked'); audio.emit('playing');
  clock += 1_000; audio.currentTime = 10.07; audio.emit('timeupdate');
  expect(audio.currentTime).toBeCloseTo(10.4);
  audio.emit('seeked'); audio.emit('playing');
  clock += 1_000; audio.currentTime = 10.5; audio.emit('timeupdate');
  expect(audio.currentTime).toBe(10.5);
  expect(audio.playCalls).toBe(1);
  expect(onIntent).not.toHaveBeenCalled();
  store.destroy();
});

test('an instantaneous media-position jump is rebased before accepting credible first progress', async () => {
  let clock = 10_000;
  const { audio, room, store, onIntent } = setup(undefined, { now: () => clock });
  audio.duration = 120;
  await room.apply({ ...frame(0), status: 'playing', playbackAllowed: true,
    positionSeconds: 5, anchorMonotonicMs: clock });
  audio.ready();
  audio.currentTime = 6; audio.emit('timeupdate');
  expect(audio.currentTime).toBe(6);
  clock += 2_000; audio.emit('timeupdate');
  expect(audio.currentTime).toBe(6); // Waiting cannot turn the same position assignment into playback.
  audio.currentTime = 6.03; audio.emit('timeupdate');
  expect(audio.currentTime).toBe(7);
  expect(onIntent).not.toHaveBeenCalled();
  store.destroy();
});

test.each(['local pause', 'shared pause', 'permission loss', 'source change', 'detach', 'native pause'] as const)(
  '%s cancels pending first-progress correction', async cancellation => {
    let clock = 10_000;
    const { audio, room, store, onIntent } = setup(undefined, { now: () => clock });
    audio.duration = 120;
    const initial = { ...frame(0), status: 'playing' as const, playbackAllowed: true,
      positionSeconds: 5, anchorMonotonicMs: clock };
    await room.apply(initial); audio.ready();
    clock += 1_000;
    expect(room.correct(6)).toBe('seek');
    if (cancellation === 'local pause') room.pauseLocally();
    else if (cancellation === 'shared pause') await room.apply({ ...initial, revision: 2, playbackEpoch: initial.playbackEpoch + 1, status: 'paused' });
    else if (cancellation === 'permission loss') await room.apply({ ...initial, revision: 2, playbackAllowed: false });
    else if (cancellation === 'source change') {
      await room.apply({ ...initial, revision: 2, playbackEpoch: initial.playbackEpoch + 1,
        currentEntryId: 'entry-b', mediaRevision: 'b', status: 'preparing', playbackAllowed: false });
      audio.ready();
    }
    else if (cancellation === 'detach') room.detach();
    else audio.pause();
    // A late native progress callback cannot consume authority from before cancellation.
    audio.paused = false; audio.currentTime = 5.1; audio.emit('seeked'); audio.emit('timeupdate');
    expect(audio.currentTime).toBe(5.1);
    expect(audio.playbackRate).toBe(1);
    expect(onIntent).not.toHaveBeenCalled();
    store.destroy();
  }
);

test('first-progress correction waits for source and seek readiness, and a new occurrence gets its own baseline', async () => {
  let clock = 10_000;
  const { audio, room, store, onIntent } = setup(undefined, { now: () => clock });
  audio.duration = 120;
  const initial = { ...frame(0), status: 'playing' as const, playbackAllowed: true,
    positionSeconds: 5, anchorMonotonicMs: clock };
  await room.apply(initial); audio.ready();
  clock += 1_000;
  audio.currentTime = 5.1; audio.currentSrc = queue[1].streamUrl; audio.emit('timeupdate');
  expect(audio.currentTime).toBe(5.1);
  audio.currentSrc = audio.src; audio.seeking = true; audio.emit('timeupdate');
  expect(audio.currentTime).toBe(5.1);
  audio.seeking = false; audio.readyState = 2; audio.emit('timeupdate');
  expect(audio.currentTime).toBe(5.1);
  audio.readyState = 4; audio.emit('timeupdate');
  expect(audio.currentTime).toBe(6);

  const preparing = { ...initial, revision: 2, playbackEpoch: initial.playbackEpoch + 1,
    currentEntryId: 'entry-b', mediaRevision: 'b', status: 'preparing' as const,
    playbackAllowed: false, positionSeconds: 20, anchorMonotonicMs: clock };
  await room.apply(preparing); audio.ready();
  audio.paused = false; audio.currentTime = 20.1; audio.emit('timeupdate');
  expect(audio.currentTime).toBe(20.1);
  await room.apply({ ...preparing, revision: 3, status: 'playing', playbackAllowed: true });
  expect(audio.currentTime).toBe(20);
  clock += 1_000;
  audio.emit('playing'); audio.emit('timeupdate');
  expect(audio.currentTime).toBe(20);
  audio.currentTime = 20.03; audio.emit('timeupdate');
  expect(audio.currentTime).toBe(21);
  expect(audio.playCalls).toBe(2);
  expect(onIntent).not.toHaveBeenCalled();
  store.destroy();
});

test('late-join readiness prepares the current position without playing before server confirmation', async () => {
  vi.useFakeTimers();
  const { audio, room, store, onIntent, onObservation } = setup();
  const playing = { ...frame(0), status: 'playing' as const, playbackAllowed: false };
  await room.apply(playing); audio.ready(); await Promise.resolve();
  expect(onObservation).toHaveBeenCalledWith(expect.objectContaining({ type: 'ready' }));
  expect(audio.playCalls).toBe(0);
  await room.apply({ ...playing, revision: 2, playbackAllowed: true });
  expect(audio.playCalls).toBe(1);
  room.pauseLocally();
  await room.apply({ ...playing, revision: 3, playbackAllowed: false });
  await room.resync();
  expect(audio.playCalls).toBe(1);
  await room.apply({ ...playing, revision: 4, playbackAllowed: true });
  expect(audio.playCalls).toBe(2);
  expect(audio.loadCalls).toBe(1);
  expect(onIntent).not.toHaveBeenCalled();
  store.destroy();
});

test('shared trace ignores stale/duplicate frames and preserves one source across membership and seek changes', async () => {
  const { audio, room, store, onIntent, factory } = setup();
  for (const [index, value] of trace.snapshots.entries()) {
    const loads = audio.loadCalls;
    const plays = audio.playCalls;
    expect(await room.apply(frame(index))).toBe(value.expectedDisposition === 'applied');
    audio.ready();
    await Promise.resolve();
    if (['duplicate', 'membership-only', 'stale'].includes(value.name)) {
      expect(audio.loadCalls).toBe(loads);
      expect(audio.playCalls).toBe(plays);
      expect(store.getSnapshot().currentItem?.id).toBe(queue[1].id);
    }
    for (const event of ['seeked', 'pause', 'playing', 'ended', 'timeupdate']) audio.emit(event);
  }
  expect(audio.loadCalls).toBe(2);
  expect(audio.playCalls).toBe(1);
  expect(audio.currentTime).toBe(0.5);
  expect(factory).toHaveBeenCalledTimes(1);
  expect(onIntent).not.toHaveBeenCalled();
  store.destroy();
});

test('explicit UI and MediaSession actions emit frozen expected-state intents without optimistic playback', async () => {
  const { audio, room, store, onIntent, actions } = setup();
  await room.apply(frame(1));
  audio.ready();
  await store.next();
  actions.get('nexttrack')?.({});
  actions.get('seekto')?.({ seekTime: 1 });
  await store.previous();
  await store.play();
  store.pause();
  expect(room.select('entry-c')).toBe(true);
  expect(room.select('unknown')).toBe(false);
  expect(onIntent.mock.calls.map(([intent]) => intent.type)).toEqual(['next', 'next', 'seek', 'previous', 'play', 'pause', 'select']);
  for (const [intent] of onIntent.mock.calls) {
    expect(Object.isFrozen(intent)).toBe(true);
    expect(intent).toMatchObject({ expectedEntryId: 'entry-b', expectedPlaybackEpoch: 42, expectedControlEpoch: 1, expectedQueueRevision: 1 });
  }
  await room.apply({ ...frame(1), revision: 6, controlEpoch: 2 });
  expect(onIntent.mock.calls[0][0].expectedControlEpoch).toBe(1);
  expect(audio.playCalls).toBe(0);
  expect(audio.currentTime).toBe(0);
  store.destroy();
});

test('room mode refuses unrelated browse queue launches and keeps shuffle/repeat and volume personal', async () => {
  const { room, store, audio, onIntent } = setup();
  await room.apply(frame(0));
  audio.ready();
  await expect(store.launchQueue(queue, 2)).rejects.toThrow('Leave room');
  await expect(store.launchAlbumQueue([], 0)).rejects.toThrow('Leave room');
  await expect(store.launchStandalone(queue[2])).rejects.toThrow('Leave room');
  store.toggleShuffle(); store.cycleRepeatMode(); store.setVolume(0.25); store.toggleMute();
  expect(store.getSnapshot()).toMatchObject({ currentItem: { id: queue[0].id }, shuffleEnabled: false, repeatMode: 'off', volume: 0.25, muted: true });
  expect(onIntent).not.toHaveBeenCalled();
  store.destroy();
});

test('natural completion cannot advance even while everyone can send Next, and emits no intent', async () => {
  const { room, audio, store, onIntent, onObservation } = setup();
  await room.apply(frame(5));
  audio.ready();
  audio.ended = true; audio.currentTime = audio.duration;
  audio.emit('ended'); audio.emit('ended');
  expect(store.getSnapshot()).toMatchObject({ currentItem: { id: queue[1].id }, status: 'ended' });
  expect(onObservation.mock.calls.filter(([value]) => value.type === 'ended')).toHaveLength(1);
  expect(onIntent).not.toHaveBeenCalled();
  store.destroy();
});

test('a deliberate local pause survives remote play, selection, and delayed callbacks until explicit resync', async () => {
  const { room, audio, store, onIntent } = setup();
  await room.apply(frame(5)); audio.ready();
  room.pauseLocally();
  await room.apply({ ...frame(5), revision: 6, playbackEpoch: 45, currentEntryId: 'entry-c', mediaRevision: 'c' });
  audio.ready();
  audio.paused = false; audio.emit('playing'); // Late event cannot undo local suspension.
  expect(audio.paused).toBe(true);
  expect(store.getSnapshot().status).toBe('paused');
  expect(audio.playCalls).toBe(1);
  await room.resync();
  expect(audio.playCalls).toBe(2);
  expect(store.getSnapshot().status).toBe('playing');
  expect(onIntent).not.toHaveBeenCalled();
  store.destroy();
});

test('metadata and seek readiness are distinct from actual start, and old source events are ignored', async () => {
  const { room, audio, onObservation, store } = setup();
  audio.autoStart = false;
  await room.apply(frame(5));
  expect(onObservation).not.toHaveBeenCalled();
  audio.currentSrc = '/synthetic/a.wav'; audio.readyState = 4; audio.emit('canplay');
  expect(audio.playCalls).toBe(0);
  audio.currentSrc = audio.src; audio.seeking = true; audio.emit('loadedmetadata');
  expect(audio.playCalls).toBe(0);
  audio.seeking = false; audio.emit('seeked');
  await Promise.resolve();
  expect(audio.playCalls).toBe(1);
  expect(onObservation.mock.calls.map(([value]) => value.type)).toEqual(['seek-complete', 'ready']);
  expect(store.getSnapshot().status).toBe('loading');
  audio.emit('playing'); audio.emit('playing');
  expect(onObservation.mock.calls.map(([value]) => value.type)).toEqual(['seek-complete', 'ready', 'actual-start']);
  store.destroy();
});

test('autoplay denial remains paused and needs explicit resync without claiming actual start', async () => {
  const { room, audio, store, onObservation } = setup();
  audio.rejectPlay = true;
  await room.apply(frame(5)); audio.ready();
  await Promise.resolve(); await Promise.resolve();
  expect(store.getSnapshot()).toMatchObject({ status: 'paused', error: { code: 'autoplayBlocked' } });
  expect(onObservation.mock.calls.some(([value]) => value.type === 'actual-start')).toBe(false);
  audio.rejectPlay = false;
  await room.resync();
  expect(store.getSnapshot().status).toBe('playing');
  store.destroy();
});

test('a media 429 network failure retries the exact pinned source only on explicit local resync', async () => {
  let clock = 10_000;
  const { room, audio, store, onIntent, onObservation, factory } = setup(undefined, { now: () => clock });
  audio.duration = 120;
  const initial = { ...frame(0), status: 'playing' as const, positionSeconds: 5, anchorMonotonicMs: clock,
    canControl: false, playbackAllowed: true,
    queue: queue.map(item => ({ ...item, streamUrl: `/content/mediaTrack/stream/${item.id}?revision=${frame(0).mediaRevision}` })) };
  await room.apply(initial);
  const pinnedSource = audio.src;
  // HTMLMediaElement exposes a rejected HTTP media load as MEDIA_ERR_NETWORK, without its HTTP status.
  audio.currentSrc = audio.src; audio.error = { code: 2 }; audio.readyState = 0; audio.emit('error');
  expect(store.getSnapshot()).toMatchObject({ status: 'error', error: { code: 'network' } });
  await room.apply({ ...initial, revision: initial.revision + 1 });
  expect(audio.loadCalls).toBe(1);
  expect(onObservation.mock.calls.map(([value]) => value.type)).toEqual(['media-failed']);
  clock += 4000;
  await room.resync();
  expect(audio.loadCalls).toBe(2); expect(audio.src).toBe(pinnedSource);
  expect(audio.paused).toBe(true); expect(audio.playCalls).toBe(0);
  expect(store.getSnapshot().error).toBeNull();
  audio.ready();
  expect(audio.currentTime).toBe(9); expect(audio.paused).toBe(false);
  expect(onObservation).toHaveBeenCalledWith(expect.objectContaining({ type: 'ready', entryId: initial.currentEntryId }));
  expect(factory).toHaveBeenCalledTimes(1); expect(onIntent).not.toHaveBeenCalled();
  store.destroy();
});

test('the real player port keeps one retry while native metadata is pending and preserves a later local pause', async () => {
  vi.useFakeTimers();
  const { room, audio, store, onIntent, onObservation } = setup(); audio.duration = 120;
  const initial = { ...frame(0), status: 'playing' as const, positionSeconds: 5,
    anchorMonotonicMs: 10_000, playbackAllowed: true };
  await room.apply(initial);
  audio.currentSrc = audio.src; audio.error = { code: 2 }; audio.emit('error');
  await room.resync(); // Actual playerStore.install has already resolved, but no native metadata exists.
  for (let index = 0; index < 20; index++) await room.resync();
  await vi.advanceTimersByTimeAsync(9999); await room.resync();
  expect(audio.readyState).toBe(0); expect(audio.loadCalls).toBe(2);
  expect(audio.playCalls).toBe(0);
  expect(onObservation.mock.calls.map(([value]) => value.type)).toEqual(['media-failed']);
  room.pauseLocally(); audio.ready();
  expect(audio.paused).toBe(true); expect(audio.playCalls).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  await room.resync();
  expect(audio.loadCalls).toBe(2); expect(audio.playCalls).toBe(1);
  expect(onIntent).not.toHaveBeenCalled(); store.destroy();
});

test('native error releases retry ownership and a missing-metadata deadline permits another explicit load', async () => {
  vi.useFakeTimers();
  const { room, audio, store, onObservation, onIntent } = setup(); audio.duration = 120;
  await room.apply({ ...frame(0), status: 'playing', playbackAllowed: true, anchorMonotonicMs: 10_000 });
  await room.resync(); expect(audio.loadCalls).toBe(2);
  audio.currentSrc = audio.src; audio.error = { code: 2 }; audio.emit('error');
  expect(vi.getTimerCount()).toBe(0);
  await room.resync(); expect(audio.loadCalls).toBe(3);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(audio.loadCalls).toBe(3); expect(audio.playCalls).toBe(0); expect(vi.getTimerCount()).toBe(0);
  await room.resync(); expect(audio.loadCalls).toBe(4);
  audio.ready();
  expect(audio.playCalls).toBe(1);
  expect(onObservation).toHaveBeenCalledWith(expect.objectContaining({ type: 'ready' }));
  expect(onIntent).not.toHaveBeenCalled(); store.destroy();
});

test('metadata arriving after the retry deadline cannot resume until another explicit gesture', async () => {
  vi.useFakeTimers();
  const { room, audio, store, onObservation, onIntent } = setup(); audio.duration = 120;
  await room.apply({ ...frame(0), status: 'playing', playbackAllowed: true, anchorMonotonicMs: 10_000 });
  await room.resync(); await vi.advanceTimersByTimeAsync(10_000); audio.ready();
  expect(audio.loadCalls).toBe(2); expect(audio.playCalls).toBe(0);
  expect(onObservation.mock.calls.some(([value]) => value.type === 'ready')).toBe(false);
  await room.resync();
  expect(audio.loadCalls).toBe(2); expect(audio.playCalls).toBe(1);
  expect(onIntent).not.toHaveBeenCalled(); store.destroy();
});

test.each(['replacement', 'controller', 'account'] as const)('the real player port clears native retry ownership on %s', async transition => {
  vi.useFakeTimers();
  const { room, audio, store, onIntent, onObservation } = setup(); audio.duration = 120;
  const initial = { ...frame(0), status: 'paused' as const, positionSeconds: 5, anchorMonotonicMs: 10_000 };
  await room.apply(initial); await room.resync();
  expect(vi.getTimerCount()).toBe(1);
  let unsubscribe: (() => void) | undefined;
  if (transition === 'replacement') await room.apply({ ...initial, revision: initial.revision + 1,
    playbackEpoch: initial.playbackEpoch + 1, currentEntryId: 'entry-b', mediaRevision: 'replacement' });
  if (transition === 'controller') {
    const replacement = store.attachRoomPlayback({ onIntent, onObservation, now: () => 10_000 });
    await replacement.apply(initial);
  }
  if (transition === 'account') {
    unsubscribe = subscribeToAccountEpoch(() => room.detach()); advanceAccountEpoch();
  }
  expect(vi.getTimerCount()).toBe(0);
  const loads = audio.loadCalls;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(audio.loadCalls).toBe(loads); expect(audio.playCalls).toBe(0);
  expect(onIntent).not.toHaveBeenCalled(); unsubscribe?.(); store.destroy();
});

test.each([0, NaN, Infinity])('explicit resync reloads unavailable metadata with duration=%s without creating a shared command', async duration => {
  const { room, audio, store, onIntent } = setup(undefined, { now: () => 10_000 });
  const initial = { ...frame(0), status: 'paused' as const, positionSeconds: 5, anchorMonotonicMs: 10_000 };
  await room.apply(initial); audio.readyState = 1; audio.currentSrc = audio.src; audio.duration = duration;
  await room.resync();
  expect(audio.loadCalls).toBe(2); expect(audio.src).toBe(queue[0].streamUrl);
  audio.duration = 120; audio.ready();
  expect(audio.currentTime).toBe(5); expect(audio.playCalls).toBe(0);
  expect(onIntent).not.toHaveBeenCalled();
  store.destroy();
});

test('persistent media failure stays unready and cannot trigger an automatic source retry', async () => {
  vi.useFakeTimers();
  const { room, audio, store, onObservation, onIntent } = setup(); audio.duration = 120;
  const initial = { ...frame(0), status: 'playing' as const, positionSeconds: 0, anchorMonotonicMs: 10_000, playbackAllowed: true };
  await room.apply(initial);
  audio.currentSrc = audio.src; audio.error = { code: 2 }; audio.emit('error');
  await room.resync();
  audio.currentSrc = audio.src; audio.error = { code: 2 }; audio.readyState = 4; audio.emit('error');
  for (const event of ['loadedmetadata', 'canplay', 'seeked', 'timeupdate']) audio.emit(event);
  audio.paused = false; audio.emit('playing');
  await room.apply({ ...initial, revision: initial.revision + 1, playbackEpoch: initial.playbackEpoch + 1 });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(room.correct(30)).toBe('none');
  expect(audio.loadCalls).toBe(2); expect(audio.playCalls).toBe(0);
  expect(onObservation.mock.calls.some(([value]) => value.type === 'ready')).toBe(false);
  expect(store.getSnapshot().error).toMatchObject({ code: 'network' });
  expect(audio.paused).toBe(true);
  expect(onIntent).not.toHaveBeenCalled();
  store.destroy();
});

test('an initial load with no metadata can be retried explicitly while the shared room stays paused', async () => {
  const { room, audio, store, onObservation, onIntent } = setup();
  await room.apply({ ...frame(0), status: 'paused', positionSeconds: 0 });
  expect(audio.readyState).toBe(0); expect(audio.error).toBeNull();
  await room.resync();
  expect(audio.loadCalls).toBe(2); expect(onObservation).not.toHaveBeenCalled();
  audio.ready();
  expect(audio.playCalls).toBe(0);
  expect(onObservation).toHaveBeenCalledWith(expect.objectContaining({ type: 'ready' }));
  expect(onIntent).not.toHaveBeenCalled(); store.destroy();
});

test('a rejected explicit source installation remains fenced without retrying automatically', async () => {
  vi.useFakeTimers();
  const { room, audio, install, ready, onObservation, onIntent } = setupSourceRetry();
  await room.apply({ ...frame(0), status: 'playing', playbackAllowed: true });
  audio.error = { code: 2 };
  install.mockRejectedValueOnce(new Error('Synthetic source installation failure.'));
  await room.resync();
  expect(audio.paused).toBe(true);
  expect(onObservation.mock.calls.filter(([value]) => value.type === 'media-failed')).toHaveLength(1);
  audio.error = null; ready();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(install).toHaveBeenCalledTimes(2); expect(audio.playCalls).toBe(0);
  expect(onObservation.mock.calls.some(([value]) => value.type === 'ready')).toBe(false);
  await room.resync();
  expect(install).toHaveBeenCalledTimes(2); expect(audio.playCalls).toBe(1);
  expect(onObservation.mock.calls.some(([value]) => value.type === 'ready')).toBe(true);
  expect(onIntent).not.toHaveBeenCalled(); room.detach();
});

test('overlapping explicit retries share one load and a pause during that load survives its completion', async () => {
  const { room, audio, install, ready, onIntent, onObservation } = setupSourceRetry();
  await room.apply({ ...frame(0), status: 'playing', playbackAllowed: true });
  audio.error = { code: 2 };
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const installSource = install.getMockImplementation()!;
  install.mockImplementationOnce(async (...args) => { await installSource(...args); await pending; });
  const retry = room.resync();
  await room.resync();
  expect(install).toHaveBeenCalledTimes(2);
  ready(); expect(onObservation).not.toHaveBeenCalled();
  room.pauseLocally(); finish(); await retry;
  expect(audio.playCalls).toBe(0); expect(audio.paused).toBe(true);
  await room.resync();
  expect(install).toHaveBeenCalledTimes(2); expect(audio.playCalls).toBe(1);
  expect(onIntent).not.toHaveBeenCalled();
  room.detach();
});

test('an expired installation cannot release ownership of a newer retry for the same occurrence', async () => {
  vi.useFakeTimers();
  const { room, audio, install, ready, onIntent } = setupSourceRetry();
  await room.apply({ ...frame(0), status: 'playing', playbackAllowed: true, anchorMonotonicMs: 10_000 });
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const installSource = install.getMockImplementation()!;
  install.mockImplementationOnce(async (...args) => { await installSource(...args); await pending; });
  const expired = room.resync();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(install).toHaveBeenCalledTimes(2);
  await room.resync(); expect(install).toHaveBeenCalledTimes(3);
  finish(); await expired; await room.resync();
  expect(install).toHaveBeenCalledTimes(3); expect(audio.playCalls).toBe(0);
  ready(); expect(audio.playCalls).toBe(1);
  expect(onIntent).not.toHaveBeenCalled(); room.detach();
});

test('a physical-source change clears native load ownership and ignores its stale callbacks', async () => {
  vi.useFakeTimers();
  const { room, controller, audio, install, ready, onObservation, changePhysicalSource } = setupSourceRetry();
  await room.apply({ ...frame(0), status: 'playing', playbackAllowed: true, anchorMonotonicMs: 10_000 });
  await room.resync(); expect(vi.getTimerCount()).toBe(1);
  changePhysicalSource(); ready();
  expect(vi.getTimerCount()).toBe(0); expect(onObservation).not.toHaveBeenCalled();
  expect(audio.playCalls).toBe(0);
  audio.readyState = 0; await room.resync();
  expect(install).toHaveBeenCalledTimes(3);
  expect(controller.observe('playing', audio)).toBe(false);
  room.detach();
});

test('a same-occurrence preparation completion during explicit retry uses the latest readiness permission', async () => {
  const { room, audio, install, ready, onObservation, onIntent } = setupSourceRetry();
  const initial = { ...frame(0), status: 'preparing' as const, playbackAllowed: false, positionSeconds: 5, anchorMonotonicMs: 10_000 };
  await room.apply(initial); audio.error = { code: 2 };
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const installSource = install.getMockImplementation()!;
  install.mockImplementationOnce(async (...args) => { await installSource(...args); await pending; });
  const retry = room.resync();
  await room.apply({ ...initial, revision: initial.revision + 1, status: 'playing', playbackAllowed: true });
  ready(); expect(onObservation).not.toHaveBeenCalled();
  finish(); await retry;
  expect(audio.currentTime).toBe(5); expect(audio.playCalls).toBe(1);
  expect(onObservation).toHaveBeenCalledWith(expect.objectContaining({ type: 'ready', playbackEpoch: initial.playbackEpoch }));
  expect(install).toHaveBeenCalledTimes(2); expect(onIntent).not.toHaveBeenCalled(); room.detach();
});

test('synchronous controller detachment while pausing cannot begin an explicit source retry', async () => {
  const { room, audio, install, port, onIntent } = setupSourceRetry();
  await room.apply(frame(0)); audio.error = { code: 2 };
  const pause = port.pause;
  port.pause = () => { pause(); room.detach(); };
  await room.resync();
  expect(install).toHaveBeenCalledTimes(1); expect(audio.playCalls).toBe(0);
  expect(onIntent).not.toHaveBeenCalled();
});

test.each(['replacement', 'controller', 'account', 'physical-source'] as const)('%s transition fences a pending explicit source retry and its late callbacks', async transition => {
  const { room, controller, audio, install, port, ready, onIntent, onObservation, changePhysicalSource } = setupSourceRetry();
  const initial = { ...frame(0), status: 'playing' as const, playbackAllowed: true, anchorMonotonicMs: 10_000 };
  await room.apply(initial); audio.error = { code: 2 };
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const installSource = install.getMockImplementation()!;
  install.mockImplementationOnce(async (...args) => { await installSource(...args); await pending; });
  const retry = room.resync(); ready(); expect(onObservation).not.toHaveBeenCalled();
  let unsubscribe: (() => void) | undefined;
  let replacement: ReturnType<typeof createRoomPlaybackController> | undefined;
  if (transition === 'replacement') {
    await room.apply({ ...initial, revision: initial.revision + 1, playbackEpoch: initial.playbackEpoch + 1,
      currentEntryId: 'entry-b', mediaRevision: 'replacement-revision', positionSeconds: 12,
      queue: [queue[0], { ...queue[1], streamUrl: '/replacement-pinned.wav' }, queue[2]] });
    ready();
  } else if (transition === 'account') {
    unsubscribe = subscribeToAccountEpoch(() => room.detach()); advanceAccountEpoch();
  } else if (transition === 'controller') {
    room.detach();
    replacement = createRoomPlaybackController(port, { now: () => 10_000, onIntent, onObservation });
    await replacement.attachment.apply({ ...initial, currentEntryId: 'entry-b', status: 'paused', positionSeconds: 12 });
    audio.currentSrc = audio.src; audio.readyState = 4;
    replacement.observe('loadedmetadata', audio);
  }
  else changePhysicalSource();
  const reports = onObservation.mock.calls.length, plays = audio.playCalls, position = audio.currentTime;
  finish(); await retry;
  if (transition === 'replacement') audio.currentSrc = queue[0].streamUrl;
  for (const event of ['loadedmetadata', 'canplay', 'seeked', 'playing']) controller.observe(event, audio);
  expect(onObservation).toHaveBeenCalledTimes(reports); expect(audio.playCalls).toBe(plays);
  expect(audio.currentTime).toBe(position); expect(onIntent).not.toHaveBeenCalled();
  unsubscribe?.(); replacement?.attachment.detach(); room.detach();
});

test('superseded scheduled starts and detached handles cannot resume or overwrite the current room', async () => {
  vi.useFakeTimers();
  const { room, audio, store } = setup();
  await room.apply({ ...frame(5), anchorMonotonicMs: 12000 }); audio.ready();
  expect(audio.playCalls).toBe(0);
  await room.apply(frame(6));
  await vi.advanceTimersByTimeAsync(2500);
  expect(audio.playCalls).toBe(0);
  const replacement = store.attachRoomPlayback({ onIntent: vi.fn(), now: () => 10000 });
  expect(await room.apply({ ...frame(5), revision: 100 })).toBe(false);
  await room.resync(); room.detach();
  expect(await replacement.apply(frame(0))).toBe(true);
  expect(await replacement.apply({ ...frame(1), epoch: 2 })).toBe(false);
  expect(await replacement.apply({ ...frame(1), roomId: 'other-room' })).toBe(false);
  expect(store.getSnapshot().currentItem?.id).toBe(queue[0].id);
  store.destroy();
});

test('rate correction resets by deadline and uses seek fallback; unsupported rate is observable', async () => {
  vi.useFakeTimers();
  const { room, audio, store, onObservation } = setup();
  audio.duration = 20;
  await room.apply(frame(5)); audio.ready();
  audio.currentTime = 1;
  expect(room.correct(1.3)).toBe('rate');
  expect(audio.playbackRate).toBe(1.05);
  await vi.advanceTimersByTimeAsync(4000);
  expect(audio.playbackRate).toBe(1);
  expect(audio.currentTime).toBeCloseTo(5.3);
  audio.emit('seeked');
  await vi.advanceTimersByTimeAsync(100);
  audio.currentTime += 0.1; audio.emit('timeupdate'); // Complete the fallback before starting an independent correction.
  audio.currentTime = 1;
  Object.defineProperty(audio, 'playbackRate', { get: () => 1, set: () => { throw new Error('Unsupported'); } });
  expect(room.correct(1.3)).toBe('seek');
  expect(audio.currentTime).toBeCloseTo(1.3);
  expect(onObservation.mock.calls.some(([value]) => value.type === 'unsupported-rate')).toBe(true);
  store.destroy();
});

test('overlapping installs retain the newer entry and old-source metadata cannot make it ready', async () => {
  const { room, audio, store, onObservation, onIntent } = setup();
  const first = room.apply(frame(0));
  const second = room.apply(frame(1));
  await Promise.all([first, second]);
  audio.currentSrc = queue[0].streamUrl;
  audio.readyState = 4;
  audio.error = { code: 2 }; audio.emit('error'); audio.error = null;
  audio.emit('loadedmetadata'); audio.emit('seeked'); audio.emit('playing');
  expect(onObservation).not.toHaveBeenCalled();
  expect(store.getSnapshot().currentItem?.id).toBe(queue[1].id);
  audio.ready();
  expect(onObservation.mock.calls.every(([value]) => value.entryId === 'entry-b')).toBe(true);
  expect(onIntent).not.toHaveBeenCalled();
  store.destroy();
});

test('same-source callbacks cannot report a new occurrence started before its seek completes', async () => {
  const { room, audio, store, onObservation, onIntent } = setup();
  await room.apply(frame(5)); audio.ready();
  audio.seeking = true;
  await room.apply({ ...frame(5), revision: 8, playbackEpoch: 60, positionSeconds: 1 });
  audio.paused = false;
  audio.emit('seeked'); audio.emit('playing');
  expect(onObservation.mock.calls.some(([value]) => value.playbackEpoch === 60)).toBe(false);
  expect(audio.paused).toBe(true);
  audio.seeking = false; audio.emit('seeked');
  expect(onObservation.mock.calls.some(([value]) => value.type === 'actual-start' && value.playbackEpoch === 60)).toBe(true);
  expect(onIntent).not.toHaveBeenCalled();
  store.destroy();
});

test('drift correction cannot overwrite an unfinished readiness seek', async () => {
  vi.useFakeTimers();
  const { room, audio, store, onObservation } = setup();
  await room.apply(frame(5)); audio.ready();
  audio.seeking = true;
  await room.apply({ ...frame(5), revision: 8, playbackEpoch: 60, positionSeconds: 1, anchorMonotonicMs: 10_000, playbackAllowed: false });
  expect(room.correct(1.4)).toBe('none');
  expect(audio.currentTime).toBe(1);
  audio.seeking = false; audio.emit('seeked');
  expect(onObservation.mock.calls.some(([value]) => value.type === 'unsupported-seek')).toBe(false);
  expect(onObservation.mock.calls.some(([value]) => value.type === 'ready' && value.playbackEpoch === 60)).toBe(true);
  store.destroy();
});

test('a pending old play promise cannot resume local pause or a replacement attachment', async () => {
  class DeferredRoomAudio extends RoomAudio {
    pending: Array<() => void> = [];
    override play() {
      this.playCalls += 1;
      return new Promise<void>((resolve) => this.pending.push(() => {
        this.paused = false; this.emit('play'); this.emit('playing'); resolve();
      }));
    }
  }
  const audio = new DeferredRoomAudio();
  const { room, store, onIntent, onObservation } = setup(audio);
  await room.apply(frame(5)); audio.ready();
  room.pauseLocally();
  audio.pending.shift()?.(); await Promise.resolve();
  expect(audio.paused).toBe(true);
  expect(onObservation.mock.calls.some(([value]) => value.type === 'actual-start')).toBe(false);
  const pending = room.resync();
  const replacement = store.attachRoomPlayback({ onIntent, onObservation, now: () => 10000 });
  await replacement.apply(frame(0)); audio.ready();
  audio.pending.shift()?.(); await pending;
  expect(audio.paused).toBe(true);
  expect(store.getSnapshot()).toMatchObject({ currentItem: { id: queue[0].id }, status: 'paused', error: null });
  expect(onIntent).not.toHaveBeenCalled();
  store.destroy();
});

test('a completed but inaccurate seek reports unsupported instead of readiness or automatic retry', async () => {
  const { room, audio, store, onObservation } = setup();
  audio.seeking = true;
  await room.apply(frame(6)); audio.ready();
  audio.currentTime = 0; audio.seeking = false; audio.emit('seeked'); audio.emit('canplay');
  expect(onObservation.mock.calls.map(([value]) => value.type)).toEqual(['unsupported-seek']);
  expect(audio.playCalls).toBe(0);
  expect(audio.currentTime).toBe(0);
  await room.resync();
  expect(onObservation.mock.calls.map(([value]) => value.type)).toEqual(['unsupported-seek', 'seek-complete', 'ready']);
  store.destroy();
});

test.each(['playing', 'paused'] as const)('hiding an Audio room preserves its %s state without changing readiness', async status => {
  const { audio, room, store, visibility, onIntent, onObservation } = setupLifecycle();
  await room.apply({ ...frame(5), status }); audio.ready();
  const plays = audio.playCalls;
  const observations = onObservation.mock.calls.length;
  visibility.hidden = true; visibility.dispatchEvent(new Event('visibilitychange'));
  expect(audio.paused).toBe(status === 'paused');
  expect(audio.playCalls).toBe(plays);
  expect(onObservation).toHaveBeenCalledTimes(observations);
  expect(onIntent).not.toHaveBeenCalled();
  store.destroy();
});

test('an initially hidden Audio room follows remote play and source changes on the existing player', async () => {
  const { audio, room, store, factory, onIntent, onObservation } = setupLifecycle(true);
  await room.apply(frame(0)); audio.ready();
  expect(audio.paused).toBe(true);
  await room.apply(frame(5)); audio.ready();
  expect(audio.paused).toBe(false);
  await room.apply({ ...frame(5), revision: 8, playbackEpoch: 45, currentEntryId: 'entry-c', mediaRevision: 'c' });
  audio.ready();
  expect(store.getSnapshot().currentItem?.id).toBe(queue[2].id);
  expect(audio.paused).toBe(false);
  expect(audio.playCalls).toBe(2);
  expect(factory).toHaveBeenCalledTimes(1);
  expect(onObservation.mock.calls.some(([value]) => value.type === 'suspended')).toBe(false);
  expect(onIntent).not.toHaveBeenCalled();
  store.destroy();
});

test('hidden Audio preserves deliberate local pause through remote changes and foreground return', async () => {
  const { audio, room, store, visibility, onIntent } = setupLifecycle();
  await room.apply(frame(5)); audio.ready();
  room.pauseLocally();
  visibility.hidden = true; visibility.dispatchEvent(new Event('visibilitychange'));
  await room.apply({ ...frame(5), revision: 8, playbackEpoch: 45, currentEntryId: 'entry-c', mediaRevision: 'c' });
  audio.ready();
  visibility.hidden = false; visibility.dispatchEvent(new Event('visibilitychange'));
  expect(audio.paused).toBe(true);
  expect(audio.playCalls).toBe(1);
  await room.resync();
  expect(audio.paused).toBe(false);
  expect(onIntent).not.toHaveBeenCalled();
  store.destroy();
});

test('hidden Video stays conservative and foreground return requires explicit resync', async () => {
  const { audio, room, store, visibility, onObservation, onIntent } = setupLifecycle();
  await room.apply({ ...frame(5), queue: queue.map(item => ({ ...item, mediaType: 'video' })) }); audio.ready();
  visibility.hidden = true; visibility.dispatchEvent(new Event('visibilitychange'));
  expect(audio.paused).toBe(true);
  expect(onObservation).toHaveBeenCalledWith(expect.objectContaining({ type: 'suspended' }));
  await room.resync();
  expect(audio.paused).toBe(true);
  visibility.hidden = false; visibility.dispatchEvent(new Event('visibilitychange'));
  expect(audio.paused).toBe(true);
  await room.resync();
  expect(audio.paused).toBe(false);
  expect(onIntent).not.toHaveBeenCalled();
  store.destroy();
});

test('installing Video into an already hidden room cannot start it', async () => {
  const { audio, room, store, onObservation } = setupLifecycle(true);
  await room.apply({ ...frame(5), queue: queue.map(item => ({ ...item, mediaType: 'video' })) }); audio.ready();
  expect(audio.playCalls).toBe(0);
  expect(onObservation).toHaveBeenCalledWith(expect.objectContaining({ type: 'suspended' }));
  await room.resync();
  expect(audio.playCalls).toBe(0);
  store.destroy();
});

test.each(['freeze', 'pagehide'])('%s cancels pending Audio start and requires explicit resync after return', async event => {
  vi.useFakeTimers();
  const { audio, room, store, visibility, pageLifecycle, onObservation, onIntent } = setupLifecycle();
  await room.apply({ ...frame(5), anchorMonotonicMs: 12000 }); audio.ready();
  (event === 'freeze' ? visibility : pageLifecycle).dispatchEvent(new Event(event));
  await vi.advanceTimersByTimeAsync(2500);
  expect(audio.playCalls).toBe(0);
  expect(onObservation).toHaveBeenCalledWith(expect.objectContaining({ type: 'suspended' }));
  visibility.dispatchEvent(new Event('resume'));
  pageLifecycle.dispatchEvent(new Event('pageshow'));
  expect(audio.playCalls).toBe(0);
  await room.resync();
  expect(audio.paused).toBe(false);
  expect(onIntent).not.toHaveBeenCalled();
  store.destroy();
});

test('freeze during source installation stays paused but explicit resync can ready the installed source', async () => {
  const { audio, room, store, visibility, onIntent } = setupLifecycle();
  const installing = room.apply(frame(5));
  visibility.dispatchEvent(new Event('freeze'));
  await installing; audio.ready();
  expect(audio.paused).toBe(true);
  visibility.dispatchEvent(new Event('resume'));
  await room.resync();
  expect(audio.paused).toBe(false);
  expect(audio.loadCalls).toBe(1);
  expect(onIntent).not.toHaveBeenCalled();
  store.destroy();
});

test('detach removes visibility and page lifecycle listeners and prevents later playback', async () => {
  const { audio, room, store, visibility, pageLifecycle, onObservation, onIntent } = setupLifecycle();
  const removeVisibility = vi.spyOn(visibility, 'removeEventListener');
  const removePage = vi.spyOn(pageLifecycle, 'removeEventListener');
  await room.apply(frame(5)); audio.ready();
  room.detach();
  const observations = onObservation.mock.calls.length;
  expect(removeVisibility.mock.calls.map(([event]) => event)).toEqual(['visibilitychange', 'freeze']);
  expect(removePage.mock.calls.map(([event]) => event)).toEqual(['pagehide']);
  visibility.hidden = true; visibility.dispatchEvent(new Event('visibilitychange'));
  visibility.dispatchEvent(new Event('freeze')); pageLifecycle.dispatchEvent(new Event('pagehide'));
  await room.resync();
  expect(audio.paused).toBe(true);
  expect(onObservation).toHaveBeenCalledTimes(observations);
  expect(onIntent).not.toHaveBeenCalled();
  store.destroy();
});

test.each(['ui', 'mediaSession'])('guest %s Play requests personal readiness while other shared controls remain blocked', async gesture => {
  const { room, store, audio, onIntent, actions } = setup();
  await room.apply({ ...frame(5), canControl: false }); audio.ready();
  expect(store.getSnapshot().status).toBe('playing');
  expect(onIntent).not.toHaveBeenCalled();
  room.pauseLocally();
  if (gesture === 'ui') await store.play();
  else actions.get('play')?.({});
  expect(onIntent).toHaveBeenCalledTimes(1);
  expect(onIntent.mock.calls[0][0]).toMatchObject({ type: 'play', expectedControlEpoch: 1 });
  expect(audio.paused).toBe(true); // The session interprets the gesture; the adapter cannot grant readiness.
  expect(await store.next()).toBe(false);
  expect(await store.previous()).toBe(false);
  store.pause(); store.seek(1);
  actions.get('nexttrack')?.({}); actions.get('pause')?.({}); actions.get('seekto')?.({ seekTime: 1 });
  expect(room.select('entry-a')).toBe(false);
  expect(onIntent).toHaveBeenCalledTimes(1);
  await room.apply({ ...frame(5), revision: 8, controlEpoch: 2, canControl: true });
  expect(await store.next()).toBe(true);
  expect(onIntent).toHaveBeenCalledTimes(2);
  expect(onIntent.mock.calls[1][0].expectedControlEpoch).toBe(2);
  store.destroy();
});

test('newer revisions cannot roll generations backward or change a timeline without advancing playback', async () => {
  const { room, store, audio, onIntent } = setup();
  const initial = { ...frame(5), controlEpoch: 3, queueRevision: 3 };
  await room.apply(initial); audio.ready();
  const loads = audio.loadCalls;
  const plays = audio.playCalls;
  const invalid: Partial<RoomPlaybackState>[] = [
    { playbackEpoch: 42 }, { controlEpoch: 2 }, { queueRevision: 2 },
    { positionSeconds: 1 }, { status: 'paused' }, { anchorMonotonicMs: 11000 },
    { currentEntryId: 'entry-a' }, { mediaRevision: 'replaced' },
    { queue: queue.map((item) => ({ ...item, streamUrl: `${item.streamUrl}?replacement=1` })) },
    { queue: queue.map((item) => ({ ...item, id: `${item.id}-replacement` })) }
  ];
  for (const patch of invalid) expect(await room.apply({ ...initial, revision: 10, ...patch })).toBe(false);
  expect(await room.apply({ ...initial, revision: 10, controlEpoch: 4, canControl: false,
    queueRevision: 4, queue: [...queue].reverse(), entryIds: ['entry-c', 'entry-b', 'entry-a'] })).toBe(true);
  expect(store.getSnapshot().queue[0].id).toBe(queue[2].id);
  expect(audio.loadCalls).toBe(loads);
  expect(audio.playCalls).toBe(plays);
  expect(onIntent).not.toHaveBeenCalled();
  store.destroy();
});

test.each([false, true])('accepted song requests and queue edits preserve playback and local pause=%s without echo', async locallyPaused => {
  const { room, store, audio, onIntent } = setup();
  const initial = { ...frame(5), queueRevision: 3 };
  await room.apply(initial); audio.ready(); await Promise.resolve();
  if (locallyPaused) room.pauseLocally();
  const before = { loads: audio.loadCalls, plays: audio.playCalls, currentTime: audio.currentTime,
    currentItem: store.getSnapshot().currentItem?.id, paused: audio.paused };
  const added = { ...queue[2], id: '000000000000000000000004', title: 'd', streamUrl: '/synthetic/d.wav' };
  const entries = [...queue, added];
  const ids = ['entry-a', 'entry-b', 'entry-c', 'entry-d'];
  expect(await room.apply({ ...initial, revision: 10, queueRevision: 4, queue: entries, entryIds: ids })).toBe(true);
  expect(await room.apply({ ...initial, revision: 11, queueRevision: 5,
    queue: [...entries].reverse(), entryIds: [...ids].reverse() })).toBe(true);
  const keep = ids.map((id, index) => ({ id, item: entries[index] })).filter(value => value.id !== 'entry-a');
  expect(initial.currentEntryId).not.toBe('entry-a');
  expect(await room.apply({ ...initial, revision: 12, queueRevision: 6,
    queue: keep.map(value => value.item), entryIds: keep.map(value => value.id) })).toBe(true);
  expect({ loads: audio.loadCalls, plays: audio.playCalls, currentTime: audio.currentTime,
    currentItem: store.getSnapshot().currentItem?.id, paused: audio.paused }).toEqual(before);
  expect(onIntent).not.toHaveBeenCalled();
  store.destroy();
});

test('synthetic normalized states enforce positive generations and a bounded nonempty queue', async () => {
  const { room, store } = setup();
  for (const key of ['revision', 'epoch', 'controlEpoch', 'queueRevision', 'playbackEpoch'] as const) {
    expect(await room.apply({ ...frame(0), [key]: 0 })).toBe(false);
  }
  expect(await room.apply({ ...frame(0), queue: [], entryIds: [] })).toBe(false);
  expect(await room.apply({ ...frame(0),
    queue: Array.from({ length: 101 }, () => queue[0]),
    entryIds: Array.from({ length: 101 }, (_, index) => `entry-${index}`), currentEntryId: 'entry-0'
  })).toBe(false);
  expect(await room.apply(frame(0))).toBe(true);
  store.destroy();
});
