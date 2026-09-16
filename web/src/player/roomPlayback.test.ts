import trace from '../../../contracts/social/prototype-v1/playback-trace.json';
import { createPlayerStore } from './playerStore';
import type { PlayerAudio, PlayerMediaSession, PlayerMediaSessionAction, PlayerMediaSessionActionDetails, PlayerQueueItem } from './types';
import type { RoomPlaybackOptions, RoomPlaybackState } from './roomPlayback';
import { createRoomPlaybackController } from './roomPlayback';
import { createActualPlaybackObserver, type ActualPlaybackObservation } from './actualPlayback';

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
  error = null;
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
  load() { this.loadCalls += 1; this.readyState = 0; this.currentSrc = ''; this.emit('loadstart'); }
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

afterEach(() => vi.useRealTimers());

test('ordinary player construction requires an explicit room controller to attach', () => {
  const store = createPlayerStore({ mediaSession: null });
  expect(() => store.attachRoomPlayback({ onIntent: vi.fn() })).toThrow('authorized room controller');
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

test.each(['local pause', 'shared pause', 'permission loss', 'detach', 'native pause'] as const)(
  '%s cancels pending first-progress correction', async cancellation => {
    let clock = 10_000;
    const { audio, room, store, onIntent } = setup(undefined, { now: () => clock });
    audio.duration = 120;
    const initial = { ...frame(0), status: 'playing' as const, playbackAllowed: true,
      positionSeconds: 5, anchorMonotonicMs: clock };
    await room.apply(initial); audio.ready();
    clock += 1_000;
    if (cancellation === 'local pause') room.pauseLocally();
    else if (cancellation === 'shared pause') await room.apply({ ...initial, revision: 2, playbackEpoch: initial.playbackEpoch + 1, status: 'paused' });
    else if (cancellation === 'permission loss') await room.apply({ ...initial, revision: 2, playbackAllowed: false });
    else if (cancellation === 'detach') room.detach();
    else audio.pause();
    // A late native progress callback cannot consume authority from before cancellation.
    audio.paused = false; audio.currentTime = 5.1; audio.emit('timeupdate');
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
  audio.currentTime = 1;
  Object.defineProperty(audio, 'playbackRate', { get: () => 1, set: () => { throw new Error('Unsupported'); } });
  expect(room.correct(1.3)).toBe('seek');
  expect(audio.currentTime).toBe(1.3);
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
