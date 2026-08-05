import { createPlayerStore } from './playerStore';
import type {
  PlayerAudio,
  PlayerMediaSession,
  PlayerMediaSessionAction,
  PlayerMediaSessionActionDetails,
  PlayerQueueItem
} from './types';

class FakeAudio implements PlayerAudio {
  src = '';
  currentTime = 0;
  duration = 0;
  volume = 1;
  muted = false;
  paused = true;
  ended = false;
  error: { code: number } | null = null;
  playbackRate = 1;
  preload = '';
  playCalls = 0;
  pauseCalls = 0;
  loadCalls = 0;
  failures: unknown[] = [];
  private readonly listeners = new Map<string, Set<() => void>>();

  async play(): Promise<void> {
    this.playCalls += 1;
    const failure = this.failures.shift();
    if (failure) throw failure;
    this.paused = false;
    this.ended = false;
    this.emit('play');
    this.emit('playing');
  }

  pause(): void {
    this.pauseCalls += 1;
    this.paused = true;
    this.emit('pause');
  }

  load(): void {
    this.loadCalls += 1;
    this.emit('loadstart');
  }

  addEventListener(type: string, listener: () => void): void {
    const eventListeners = this.listeners.get(type) ?? new Set();
    eventListeners.add(listener);
    this.listeners.set(type, eventListeners);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  removeAttribute(name: string): void {
    if (name === 'src') this.src = '';
  }

  /** Drives browser media events without depending on jsdom's audio implementation. */
  emit(type: string): void {
    this.listeners.get(type)?.forEach((listener) => listener());
  }
}

class FakeMediaSession implements PlayerMediaSession {
  metadata: unknown = null;
  playbackState: 'none' | 'paused' | 'playing' = 'none';
  positionState: { duration: number; playbackRate: number; position: number } | undefined;
  readonly handlers = new Map<
    PlayerMediaSessionAction,
    (details: PlayerMediaSessionActionDetails) => void
  >();

  setActionHandler(
    action: PlayerMediaSessionAction,
    handler: ((details: PlayerMediaSessionActionDetails) => void) | null
  ): void {
    if (handler) this.handlers.set(action, handler);
    else this.handlers.delete(action);
  }

  setPositionState(state?: {
    duration: number;
    playbackRate: number;
    position: number;
  }): void {
    this.positionState = state;
  }

  run(action: PlayerMediaSessionAction, details: PlayerMediaSessionActionDetails = {}): void {
    this.handlers.get(action)?.(details);
  }
}

class DeferredAudio extends FakeAudio {
  private readonly pendingPlays: Array<{
    resolve: () => void;
    reject: (failure: unknown) => void;
  }> = [];

  override play(): Promise<void> {
    this.playCalls += 1;
    return new Promise<void>((resolve, reject) => {
      this.pendingPlays.push({
        resolve: () => {
          this.paused = false;
          resolve();
        },
        reject
      });
    });
  }

  /** Rejects the oldest pending attempt to simulate a late browser response. */
  rejectOldest(failure: unknown): void {
    this.pendingPlays.shift()?.reject(failure);
  }
}

const tracks: PlayerQueueItem[] = [
  {
    id: 'track-1',
    title: 'Still Water',
    artworkUrl: '/art/still-water.jpg',
    artistNames: ['Aster Vale'],
    streamUrl: '/audio/still-water.mp3'
  },
  {
    id: 'track-2',
    title: 'Open Field',
    artworkUrl: '/art/open-field.jpg',
    artistNames: ['Aster Vale', 'June North'],
    streamUrl: '/audio/open-field.mp3'
  },
  {
    id: 'track-3',
    title: 'Night Window',
    artworkUrl: '',
    artistNames: ['June North'],
    streamUrl: '/audio/night-window.mp3'
  }
];

test('owns one lazy audio instance and copies an album queue before launch', async () => {
  const audio = new FakeAudio();
  const audioFactory = vi.fn(() => audio);
  const store = createPlayerStore({ audioFactory, mediaSession: null });
  const callerQueue = tracks.map((item) => ({
    ...item,
    artistNames: [...item.artistNames]
  }));

  expect(audioFactory).not.toHaveBeenCalled();
  await store.launchAlbumQueue(callerQueue, 1, { autoplay: false });

  expect(audioFactory).toHaveBeenCalledTimes(1);
  expect(store.getSnapshot()).toMatchObject({
    currentIndex: 1,
    currentItem: { id: 'track-2', title: 'Open Field' },
    upNextItem: { id: 'track-3', title: 'Night Window' },
    status: 'paused',
    shuffleEnabled: false,
    repeatMode: 'off',
    canPrevious: true,
    canNext: true
  });
  expect(audio.src).toBe('/audio/open-field.mp3');
  expect(audio.playCalls).toBe(0);

  callerQueue[1].title = 'Changed by the caller';
  callerQueue[1].artistNames.push('Changed by the caller');
  expect(store.getSnapshot().currentItem).toMatchObject({
    title: 'Open Field',
    artistNames: ['Aster Vale', 'June North']
  });

  await store.launchStandalone(tracks[0]);
  expect(audioFactory).toHaveBeenCalledTimes(1);
  expect(store.getSnapshot()).toMatchObject({
    currentIndex: 0,
    upNextItem: null,
    status: 'playing',
    canPrevious: false,
    canNext: false
  });
  expect(store.getSnapshot().queue).toHaveLength(1);
});

test('moves within queue boundaries and advances automatically on ended', async () => {
  const audio = new FakeAudio();
  const store = createPlayerStore({ audioFactory: () => audio, mediaSession: null });
  await store.launchAlbumQueue(tracks, 0);

  await expect(store.previous()).resolves.toBe(false);
  await expect(store.next()).resolves.toBe(true);
  expect(store.getSnapshot().currentItem?.id).toBe('track-2');

  audio.emit('ended');
  await vi.waitFor(() => expect(store.getSnapshot()).toMatchObject({
    currentIndex: 2,
    status: 'playing',
    canNext: false
  }));

  audio.currentTime = audio.duration = 180;
  audio.emit('durationchange');
  audio.emit('ended');
  await vi.waitFor(() => expect(store.getSnapshot()).toMatchObject({
    currentIndex: 2,
    status: 'ended',
    currentTime: 180
  }));
  await expect(store.next()).resolves.toBe(false);
});

test('shuffles only upcoming queue items without changing the current playback', async () => {
  const audio = new FakeAudio();
  const store = createPlayerStore({
    audioFactory: () => audio,
    mediaSession: null,
    random: () => 0
  });
  await store.launchAlbumQueue(tracks, 0, { autoplay: false });
  audio.duration = 180;
  audio.currentTime = 42;
  audio.emit('durationchange');
  audio.emit('timeupdate');

  store.toggleShuffle();
  expect(store.getSnapshot()).toMatchObject({
    currentItem: { id: 'track-1' },
    upNextItem: { id: 'track-3' },
    currentTime: 42,
    status: 'paused',
    shuffleEnabled: true
  });

  await expect(store.next()).resolves.toBe(true);
  expect(store.getSnapshot()).toMatchObject({
    currentItem: { id: 'track-3' },
    upNextItem: { id: 'track-2' }
  });
  await expect(store.next()).resolves.toBe(true);
  expect(store.getSnapshot()).toMatchObject({
    currentItem: { id: 'track-2' },
    upNextItem: null
  });
  await expect(store.next()).resolves.toBe(false);
});

test('keeps every unplayed item available when Shuffle starts from a selected later track', async () => {
  const audio = new FakeAudio();
  const store = createPlayerStore({
    audioFactory: () => audio,
    mediaSession: null,
    initiallyShuffleEnabled: true,
    random: () => 0
  });
  await store.launchAlbumQueue(tracks, 2, { autoplay: false });

  expect(store.getSnapshot()).toMatchObject({
    currentItem: { id: 'track-3' },
    canPrevious: false,
    canNext: true
  });
  await store.next();
  expect(store.getSnapshot().currentItem?.id).toBe('track-2');
  await store.next();
  expect(store.getSnapshot().currentItem?.id).toBe('track-1');
});

test('preserves a forward history item when Shuffle is enabled after Previous', async () => {
  const audio = new FakeAudio();
  const store = createPlayerStore({
    audioFactory: () => audio,
    mediaSession: null,
    random: () => 0
  });
  await store.launchAlbumQueue(tracks, 0, { autoplay: false });
  await store.next();
  await store.next();
  await store.previous();
  expect(store.getSnapshot().currentItem?.id).toBe('track-2');

  store.toggleShuffle();
  await expect(store.next()).resolves.toBe(true);
  expect(store.getSnapshot().currentItem?.id).toBe('track-3');
});

test('cycles Repeat modes and distinguishes natural completion from explicit navigation', async () => {
  const audio = new FakeAudio();
  const store = createPlayerStore({ audioFactory: () => audio, mediaSession: null });
  await store.launchAlbumQueue(tracks, 2, { autoplay: false });

  store.cycleRepeatMode();
  expect(store.getSnapshot()).toMatchObject({
    repeatMode: 'all',
    canNext: true,
    upNextItem: { id: 'track-1' }
  });
  audio.emit('ended');
  await vi.waitFor(() => expect(store.getSnapshot()).toMatchObject({
    currentItem: { id: 'track-1' },
    upNextItem: { id: 'track-2' }
  }));

  store.cycleRepeatMode();
  expect(store.getSnapshot()).toMatchObject({
    repeatMode: 'one',
    upNextItem: { id: 'track-1' }
  });
  audio.currentTime = 90;
  audio.emit('timeupdate');
  const sourceBeforeRepeat = audio.src;
  audio.emit('ended');
  await vi.waitFor(() => expect(store.getSnapshot()).toMatchObject({
    currentItem: { id: 'track-1' },
    currentTime: 0,
    status: 'playing'
  }));
  expect(audio.src).toBe(sourceBeforeRepeat);

  await expect(store.next()).resolves.toBe(true);
  expect(store.getSnapshot()).toMatchObject({
    currentItem: { id: 'track-2' },
    upNextItem: { id: 'track-2' }
  });
  store.cycleRepeatMode();
  expect(store.getSnapshot()).toMatchObject({
    repeatMode: 'off',
    upNextItem: { id: 'track-3' }
  });
});

test('combines shuffled traversal with Repeat All by wrapping the same playback order', async () => {
  const audio = new FakeAudio();
  const store = createPlayerStore({
    audioFactory: () => audio,
    mediaSession: null,
    initiallyShuffleEnabled: true,
    initialRepeatMode: 'all',
    random: () => 0
  });
  await store.launchAlbumQueue(tracks, 0, { autoplay: false });

  await store.next();
  expect(store.getSnapshot().currentItem?.id).toBe('track-3');
  await store.next();
  expect(store.getSnapshot().currentItem?.id).toBe('track-2');
  await store.next();
  expect(store.getSnapshot()).toMatchObject({
    currentItem: { id: 'track-1' },
    upNextItem: { id: 'track-3' },
    shuffleEnabled: true,
    repeatMode: 'all'
  });
});

test('Previous restarts after three seconds and otherwise follows playback history', async () => {
  const audio = new FakeAudio();
  const store = createPlayerStore({ audioFactory: () => audio, mediaSession: null });
  await store.launchAlbumQueue(tracks, 1, { autoplay: false });
  audio.duration = 180;
  audio.currentTime = 5;
  audio.emit('durationchange');
  audio.emit('timeupdate');

  await expect(store.previous()).resolves.toBe(true);
  expect(store.getSnapshot()).toMatchObject({
    currentItem: { id: 'track-2' },
    currentTime: 0,
    status: 'paused'
  });

  audio.currentTime = 2;
  audio.emit('timeupdate');
  await expect(store.previous()).resolves.toBe(true);
  expect(store.getSnapshot().currentItem?.id).toBe('track-1');
  await expect(store.previous()).resolves.toBe(false);

  audio.currentTime = 3;
  audio.emit('timeupdate');
  expect(store.getSnapshot().canPrevious).toBe(true);
  await expect(store.previous()).resolves.toBe(true);
  expect(store.getSnapshot()).toMatchObject({
    currentItem: { id: 'track-1' },
    currentTime: 0
  });
});

test('Repeat All restarts a single-item queue after natural completion', async () => {
  const audio = new FakeAudio();
  const store = createPlayerStore({
    audioFactory: () => audio,
    mediaSession: null,
    initialRepeatMode: 'all'
  });
  await store.launchStandalone(tracks[0], { autoplay: false });
  expect(store.getSnapshot().upNextItem?.id).toBe('track-1');

  audio.currentTime = 180;
  audio.emit('timeupdate');
  audio.emit('ended');
  await vi.waitFor(() => expect(store.getSnapshot()).toMatchObject({
    currentItem: { id: 'track-1' },
    currentTime: 0,
    status: 'playing',
    canNext: false
  }));
});

test('reports an honest ended state when a repeated source cannot seek to its start', async () => {
  const audio = new FakeAudio();
  const store = createPlayerStore({
    audioFactory: () => audio,
    mediaSession: null,
    initialRepeatMode: 'one'
  });
  await store.launchStandalone(tracks[0], { autoplay: false });
  audio.duration = 180;
  Object.defineProperty(audio, 'currentTime', {
    configurable: true,
    get: () => 180,
    set: () => { throw new Error('Seeking is unavailable.'); }
  });
  audio.emit('durationchange');

  audio.emit('ended');
  await vi.waitFor(() => expect(store.getSnapshot()).toMatchObject({
    currentItem: { id: 'track-1' },
    currentTime: 180,
    status: 'ended'
  }));
});

test('clamps seeking, skip controls, volume, and mute state', async () => {
  const audio = new FakeAudio();
  const store = createPlayerStore({ audioFactory: () => audio, mediaSession: null });
  store.setVolume(0.4);
  store.setMuted(true);
  await store.launchStandalone(tracks[0], { autoplay: false });
  expect(audio.volume).toBe(0.4);
  expect(audio.muted).toBe(true);

  audio.duration = 100;
  audio.currentTime = 50;
  audio.emit('durationchange');
  audio.emit('timeupdate');
  store.skipForward();
  expect(audio.currentTime).toBe(60);
  store.skipForward(100);
  expect(audio.currentTime).toBe(100);
  store.skipBackward(10);
  expect(audio.currentTime).toBe(90);
  store.seek(-20);
  expect(audio.currentTime).toBe(0);

  store.setVolume(5);
  expect(store.getSnapshot().volume).toBe(1);
  store.toggleMute();
  expect(store.getSnapshot().muted).toBe(false);
});

test('exposes blocked autoplay as recoverable and succeeds on a later play', async () => {
  const audio = new FakeAudio();
  audio.failures.push(new DOMException('A gesture is required.', 'NotAllowedError'));
  const onPlaybackError = vi.fn();
  const store = createPlayerStore({
    audioFactory: () => audio,
    mediaSession: null,
    onPlaybackError
  });

  await store.launchStandalone(tracks[0]);
  expect(store.getSnapshot()).toMatchObject({
    status: 'paused',
    isBuffering: false,
    error: { code: 'autoplayBlocked', recoverable: true }
  });

  await store.play();
  expect(store.getSnapshot()).toMatchObject({ status: 'playing', error: null });
  expect(audio.playCalls).toBe(2);
  expect(onPlaybackError).toHaveBeenCalledWith({
    stage: 'play_call',
    code: 'autoplayBlocked'
  });
});

test('ignores a stale play rejection after a newer source has launched', async () => {
  const audio = new DeferredAudio();
  const store = createPlayerStore({ audioFactory: () => audio, mediaSession: null });

  const staleLaunch = store.launchStandalone(tracks[0]);
  await store.launchStandalone(tracks[1], { autoplay: false });
  audio.rejectOldest(new DOMException('A gesture is required.', 'NotAllowedError'));
  await staleLaunch;

  expect(store.getSnapshot()).toMatchObject({
    currentItem: { id: 'track-2' },
    status: 'paused',
    error: null
  });
});

test('ignores stale queue-end completion after a newer source has launched', async () => {
  const audio = new FakeAudio();
  const store = createPlayerStore({ audioFactory: () => audio, mediaSession: null });
  await store.launchAlbumQueue(tracks, 2, { autoplay: false });

  audio.emit('ended');
  await store.launchStandalone(tracks[0], { autoplay: false });
  await Promise.resolve();

  expect(store.getSnapshot()).toMatchObject({
    currentItem: { id: 'track-1' },
    status: 'paused',
    error: null
  });
});

test('retains the queue through a network error so playback can retry', async () => {
  const audio = new FakeAudio();
  const onPlaybackError = vi.fn();
  const store = createPlayerStore({
    audioFactory: () => audio,
    mediaSession: null,
    onPlaybackError
  });
  await store.launchAlbumQueue(tracks, 1, { autoplay: false });

  audio.error = { code: 2 };
  audio.emit('error');
  expect(store.getSnapshot()).toMatchObject({
    currentItem: { id: 'track-2' },
    status: 'error',
    error: { code: 'network', recoverable: true }
  });
  expect(onPlaybackError).toHaveBeenCalledWith({ stage: 'media_element', code: 'network' });

  await store.play();
  expect(audio.loadCalls).toBe(2);
  expect(store.getSnapshot()).toMatchObject({
    currentItem: { id: 'track-2' },
    status: 'playing',
    error: null
  });
});

test('keeps source navigation recoverable when audio is unavailable', async () => {
  const audioFactory = vi.fn((): PlayerAudio => {
    throw new Error('Audio is unavailable.');
  });
  const onPlaybackError = vi.fn();
  const store = createPlayerStore({ audioFactory, mediaSession: null, onPlaybackError });

  await store.launchAlbumQueue(tracks, 0);
  expect(store.getSnapshot()).toMatchObject({
    currentItem: { id: 'track-1' },
    status: 'error',
    error: { code: 'streamUnavailable', recoverable: true }
  });

  await expect(store.next()).resolves.toBe(true);
  expect(store.getSnapshot()).toMatchObject({
    currentItem: { id: 'track-2' },
    status: 'error',
    error: { code: 'streamUnavailable', recoverable: true }
  });
  expect(audioFactory).toHaveBeenCalledTimes(1);
  expect(onPlaybackError).toHaveBeenCalledTimes(1);
  expect(onPlaybackError).toHaveBeenCalledWith({
    stage: 'audio_create',
    code: 'streamUnavailable'
  });
});

test('classifies an empty stream URL as a source setup failure without content metadata', async () => {
  const onPlaybackError = vi.fn();
  const store = createPlayerStore({
    audioFactory: () => new FakeAudio(),
    mediaSession: null,
    onPlaybackError
  });

  await store.launchStandalone({ ...tracks[0], streamUrl: '' });

  expect(onPlaybackError).toHaveBeenCalledWith({
    stage: 'source_set',
    code: 'streamUnavailable'
  });
  expect(onPlaybackError.mock.calls.flat()).not.toContain('track-1');
});

test('shares transport state and metadata with progressive Media Session controls', async () => {
  const audio = new FakeAudio();
  const mediaSession = new FakeMediaSession();
  const metadataFactory = vi.fn((metadata) => ({ normalized: metadata }));
  const store = createPlayerStore({
    audioFactory: () => audio,
    mediaSession,
    mediaMetadataFactory: metadataFactory
  });

  const managedArtwork = '/content/images/0123456789abcdef01234567';
  await store.launchAlbumQueue([
    { ...tracks[0], artworkUrl: managedArtwork },
    tracks[1]
  ], 0, { autoplay: false });
  expect(mediaSession.metadata).toEqual({
    normalized: {
      title: 'Still Water',
      artist: 'Aster Vale',
      artwork: [96, 192, 320, 480, 640, 960, 1280].map((width) => ({
        src: `${managedArtwork}/v1/${width}.webp`,
        sizes: `${width}x${width}`,
        type: 'image/webp'
      }))
    }
  });
  expect(mediaSession.playbackState).toBe('paused');

  audio.duration = 120;
  audio.currentTime = 30;
  audio.emit('durationchange');
  audio.emit('timeupdate');
  expect(mediaSession.positionState).toEqual({
    duration: 120,
    playbackRate: 1,
    position: 30
  });

  mediaSession.run('seekforward', { seekOffset: 5 });
  expect(store.getSnapshot().currentTime).toBe(35);
  mediaSession.run('play');
  expect(store.getSnapshot().status).toBe('playing');
  expect(mediaSession.playbackState).toBe('playing');
  mediaSession.run('nexttrack');
  expect(store.getSnapshot().currentItem?.id).toBe('track-2');
  expect(metadataFactory).toHaveBeenLastCalledWith({
    title: 'Open Field',
    artist: 'Aster Vale, June North',
    artwork: [{ src: '/art/open-field.jpg' }]
  });

  store.destroy();
  expect(mediaSession.handlers.size).toBe(0);
  expect(mediaSession.metadata).toBeNull();
  expect(mediaSession.playbackState).toBe('none');
});
