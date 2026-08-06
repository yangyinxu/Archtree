import type {
  CreatePlayerStoreOptions,
  PlayerAudio,
  PlayerErrorCode,
  PlayerErrorState,
  PlayerMediaSession,
  PlayerMediaSessionAction,
  PlayerPlaybackErrorStage,
  PlayerQueueItem,
  PlayerRepeatMode,
  PlayerSnapshot,
  PlayerStore
} from './types';
import { enqueueListenerTelemetry } from '../telemetry/client';
import { classifyListenerRoute } from '../telemetry/routeClassifier';
import {
  mediaSessionArtworkSources,
  type MediaSessionArtworkSource
} from '../artwork/artworkUrls';

const DEFAULT_SKIP_SECONDS = 10;
const PREVIOUS_RESTART_SECONDS = 3;

const errorMessages: Record<PlayerErrorCode, string> = {
  autoplayBlocked: 'Playback is ready. Select play to continue.',
  network: 'The audio could not be loaded. Check your connection and try again.',
  decode: 'This audio could not be decoded. Try another track.',
  streamUnavailable: 'This audio stream is unavailable. Try again later.',
  unknown: 'Playback failed. Try again.'
};

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(Math.max(value, minimum), maximum);

const finiteOrZero = (value: number) => Number.isFinite(value) && value >= 0 ? value : 0;

const playerError = (code: PlayerErrorCode): PlayerErrorState => ({
  code,
  message: errorMessages[code],
  recoverable: true
});

/** Converts DOM playback failures into stable presentation-safe error categories. */
const classifyPlaybackFailure = (failure: unknown): PlayerErrorCode => {
  const name = typeof failure === 'object' && failure !== null && 'name' in failure
    ? String(failure.name)
    : '';

  switch (name) {
    case 'NotAllowedError':
      return 'autoplayBlocked';
    case 'NotSupportedError':
      return 'streamUnavailable';
    case 'NetworkError':
      return 'network';
    case 'EncodingError':
      return 'decode';
    default:
      return 'unknown';
  }
};

const classifyMediaError = (code: number | undefined): PlayerErrorCode => {
  switch (code) {
    case 2:
      return 'network';
    case 3:
      return 'decode';
    case 4:
      return 'streamUnavailable';
    default:
      return 'unknown';
  }
};

const copyQueue = (queue: readonly PlayerQueueItem[]): readonly PlayerQueueItem[] =>
  Object.freeze(queue.map((item) => Object.freeze({
    ...item,
    artistNames: Object.freeze([...item.artistNames])
  })));

const initialSnapshot = (
  volume: number,
  muted: boolean,
  shuffleEnabled: boolean,
  repeatMode: PlayerRepeatMode
): PlayerSnapshot => Object.freeze({
  queue: Object.freeze([]) as readonly PlayerQueueItem[],
  currentIndex: -1,
  currentItem: null,
  upNextItem: null,
  status: 'idle',
  isBuffering: false,
  currentTime: 0,
  duration: 0,
  volume,
  muted,
  shuffleEnabled,
  repeatMode,
  error: null,
  canPrevious: false,
  canNext: false
});

const resolveMediaSession = (): PlayerMediaSession | null => {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return null;
  return navigator.mediaSession as unknown as PlayerMediaSession;
};

const defaultMetadataFactory = (metadata: {
  title: string;
  artist: string;
  artwork: MediaSessionArtworkSource[];
}): unknown => {
  if (typeof MediaMetadata === 'undefined') return metadata;
  return new MediaMetadata(metadata);
};

const defaultAudioFactory = (): PlayerAudio => {
  if (typeof Audio === 'undefined') {
    throw new Error('HTML audio is unavailable in this environment.');
  }
  return new Audio() as unknown as PlayerAudio;
};

/**
 * Owns the single audio element, immutable queue snapshot, and all transport commands.
 * Routing and activity writes deliberately remain outside this runtime boundary.
 */
export const createPlayerStore = (
  options: CreatePlayerStoreOptions = {}
): PlayerStore => {
  const audioFactory = options.audioFactory ?? defaultAudioFactory;
  const mediaSession = options.mediaSession === undefined
    ? resolveMediaSession()
    : options.mediaSession;
  const metadataFactory = options.mediaMetadataFactory ?? defaultMetadataFactory;
  const random = options.random ?? Math.random;
  const listeners = new Set<() => void>();
  const boundAudioListeners = new Map<string, () => void>();
  const registeredMediaActions = new Set<PlayerMediaSessionAction>();
  const startingVolume = clamp(
    Number.isFinite(options.initialVolume) ? options.initialVolume ?? 1 : 1,
    0,
    1
  );

  let snapshot = initialSnapshot(
    startingVolume,
    options.initiallyMuted ?? false,
    options.initiallyShuffleEnabled ?? false,
    options.initialRepeatMode ?? 'off'
  );
  let audio: PlayerAudio | null = null;
  let audioCreationAttempted = false;
  let sourceGeneration = 0;
  let playAttemptGeneration = 0;
  let lastReportedPlaybackError = '';
  let lastMediaItem: PlayerQueueItem | null | undefined;
  let playOrder: number[] = [];
  let playOrderPosition = -1;
  let actualHistory: number[] = [];
  let actualHistoryPosition = -1;
  let destroyed = false;

  const readRandom = () => {
    try {
      const value = random();
      return Number.isFinite(value) ? clamp(value, 0, 0.999999999999) : 0;
    } catch {
      return 0;
    }
  };

  const shuffled = (indices: readonly number[]) => {
    const result = [...indices];
    for (let index = result.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(readRandom() * (index + 1));
      [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
    }
    return result;
  };

  const canonicalOrder = (length: number) => Array.from({ length }, (_, index) => index);

  const launchOrder = (length: number, currentIndex: number) => {
    const canonical = canonicalOrder(length);
    if (!snapshot.shuffleEnabled) return canonical;
    return [currentIndex, ...shuffled(canonical.filter((index) => index !== currentIndex))];
  };

  const currentCycleHistory = () => {
    const uniqueHistory: number[] = [];
    actualHistory.slice(0, actualHistoryPosition + 1).forEach((index) => {
      const earlierPosition = uniqueHistory.indexOf(index);
      if (earlierPosition >= 0) uniqueHistory.splice(earlierPosition, 1);
      uniqueHistory.push(index);
    });
    return uniqueHistory;
  };

  const recordNavigation = (index: number, direction: 'previous' | 'next') => {
    const adjacentHistoryPosition = direction === 'previous'
      ? actualHistoryPosition - 1
      : actualHistoryPosition + 1;
    if (adjacentHistoryPosition >= 0
      && adjacentHistoryPosition < actualHistory.length
      && actualHistory[adjacentHistoryPosition] === index) {
      actualHistoryPosition = adjacentHistoryPosition;
      return;
    }

    actualHistory = actualHistory.slice(0, actualHistoryPosition + 1);
    actualHistory.push(index);
    actualHistoryPosition = actualHistory.length - 1;
  };

  const reportPlaybackError = (stage: PlayerPlaybackErrorStage, code: PlayerErrorCode) => {
    const signature = `${sourceGeneration}:${stage}:${code}`;
    if (signature === lastReportedPlaybackError) return;
    lastReportedPlaybackError = signature;
    try {
      options.onPlaybackError?.({ stage, code });
    } catch {
      // Monitoring is optional and must never change player state or retry behavior.
    }
  };

  const notify = () => {
    listeners.forEach((listener) => listener());
  };

  const syncMediaSession = () => {
    if (!mediaSession) return;

    if (snapshot.currentItem !== lastMediaItem) {
      lastMediaItem = snapshot.currentItem;
      try {
        mediaSession.metadata = snapshot.currentItem
          ? metadataFactory({
              title: snapshot.currentItem.title,
              artist: snapshot.currentItem.artistNames.join(', '),
              artwork: mediaSessionArtworkSources(snapshot.currentItem.artworkUrl)
            })
          : null;
      } catch {
        // Metadata is optional even when transport integration is supported.
      }
    }

    try {
      mediaSession.playbackState = snapshot.currentItem === null
        ? 'none'
        : snapshot.status === 'playing' ? 'playing' : 'paused';
    } catch {
      // Playback-state integration is optional and isolated from audio state.
    }

    try {
      if (mediaSession.setPositionState) {
        if (snapshot.currentItem && snapshot.duration > 0 && Number.isFinite(snapshot.duration)) {
          const playbackRate = audio && Number.isFinite(audio.playbackRate) && audio.playbackRate > 0
            ? audio.playbackRate
            : 1;
          mediaSession.setPositionState({
            duration: snapshot.duration,
            playbackRate,
            position: clamp(snapshot.currentTime, 0, snapshot.duration)
          });
        } else {
          mediaSession.setPositionState();
        }
      }
    } catch {
      // Position support varies independently across Media Session implementations.
    }
  };

  const updateSnapshot = (patch: Partial<PlayerSnapshot>) => {
    if (destroyed) return;

    const candidate = { ...snapshot, ...patch };
    const validIndex = candidate.currentIndex >= 0
      && candidate.currentIndex < candidate.queue.length;
    const automaticNextIndex = !validIndex
      ? -1
      : candidate.repeatMode === 'one'
        ? candidate.currentIndex
        : playOrderPosition >= 0 && playOrderPosition < playOrder.length - 1
          ? playOrder[playOrderPosition + 1]
          : candidate.repeatMode === 'all' && playOrder.length > 0
            ? playOrder[0]
            : -1;
    const next: PlayerSnapshot = Object.freeze({
      ...candidate,
      currentIndex: validIndex ? candidate.currentIndex : -1,
      currentItem: validIndex ? candidate.queue[candidate.currentIndex] : null,
      upNextItem: automaticNextIndex >= 0 && automaticNextIndex < candidate.queue.length
        ? candidate.queue[automaticNextIndex]
        : null,
      canPrevious: validIndex && (
        candidate.currentTime >= PREVIOUS_RESTART_SECONDS
        || playOrderPosition > 0
        || (candidate.repeatMode === 'all' && candidate.queue.length > 1)
      ),
      canNext: validIndex && (
        playOrderPosition >= 0 && playOrderPosition < playOrder.length - 1
        || (candidate.repeatMode === 'all' && candidate.queue.length > 1)
      )
    });

    const changed = Object.keys(next).some((key) =>
      next[key as keyof PlayerSnapshot] !== snapshot[key as keyof PlayerSnapshot]
    );
    if (!changed) return;

    snapshot = next;
    syncMediaSession();
    notify();
  };

  const readAudioTime = (target: PlayerAudio) => finiteOrZero(target.currentTime);
  const readAudioDuration = (target: PlayerAudio) => finiteOrZero(target.duration);

  const bindAudio = (target: PlayerAudio) => {
    const handlers: Record<string, () => void> = {
      loadstart: () => {
        if (!snapshot.currentItem || destroyed) return;
        updateSnapshot({ status: 'loading', isBuffering: true });
      },
      loadedmetadata: () => {
        if (!snapshot.currentItem || destroyed) return;
        updateSnapshot({
          duration: readAudioDuration(target),
          currentTime: readAudioTime(target)
        });
      },
      durationchange: () => {
        if (!snapshot.currentItem || destroyed) return;
        updateSnapshot({ duration: readAudioDuration(target) });
      },
      timeupdate: () => {
        if (!snapshot.currentItem || destroyed) return;
        updateSnapshot({ currentTime: readAudioTime(target) });
      },
      play: () => {
        if (!snapshot.currentItem || destroyed) return;
        updateSnapshot({ status: 'playing', isBuffering: false, error: null });
      },
      playing: () => {
        if (!snapshot.currentItem || destroyed) return;
        updateSnapshot({ status: 'playing', isBuffering: false, error: null });
      },
      pause: () => {
        if (!snapshot.currentItem || destroyed) return;
        if (snapshot.status === 'playing') {
          updateSnapshot({ status: 'paused', isBuffering: false });
        }
      },
      waiting: () => {
        if (!snapshot.currentItem || destroyed) return;
        updateSnapshot({ isBuffering: true });
      },
      stalled: () => {
        if (!snapshot.currentItem || destroyed) return;
        updateSnapshot({ isBuffering: true });
      },
      canplay: () => {
        if (!snapshot.currentItem || destroyed) return;
        updateSnapshot({ isBuffering: false });
      },
      volumechange: () => {
        if (destroyed) return;
        updateSnapshot({
          volume: clamp(Number.isFinite(target.volume) ? target.volume : snapshot.volume, 0, 1),
          muted: target.muted
        });
      },
      error: () => {
        if (!snapshot.currentItem || destroyed) return;
        playAttemptGeneration += 1;
        const code = classifyMediaError(target.error?.code);
        reportPlaybackError('media_element', code);
        updateSnapshot({
          status: 'error',
          isBuffering: false,
          error: playerError(code)
        });
      },
      ended: () => { void handleEnded(target); }
    };

    Object.entries(handlers).forEach(([event, handler]) => {
      boundAudioListeners.set(event, handler);
      target.addEventListener(event, handler);
    });
  };

  const ensureAudio = (): PlayerAudio | null => {
    if (audio) return audio;
    if (audioCreationAttempted || destroyed) return null;

    audioCreationAttempted = true;
    let candidate: PlayerAudio | null = null;
    try {
      candidate = audioFactory();
      candidate.preload = 'metadata';
      candidate.volume = snapshot.volume;
      candidate.muted = snapshot.muted;
      bindAudio(candidate);
      audio = candidate;
      return audio;
    } catch {
      if (candidate) {
        boundAudioListeners.forEach((listener, event) => {
          candidate?.removeEventListener(event, listener);
        });
        boundAudioListeners.clear();
      }
      audio = null;
      reportPlaybackError('audio_create', 'streamUnavailable');
      updateSnapshot({
        status: 'error',
        isBuffering: false,
        error: playerError('streamUnavailable')
      });
      return null;
    }
  };

  const attemptPlay = async (expectedSourceGeneration: number): Promise<void> => {
    if (destroyed || expectedSourceGeneration !== sourceGeneration || !snapshot.currentItem) return;
    const target = ensureAudio();
    if (!target) return;

    const attempt = ++playAttemptGeneration;
    updateSnapshot({ status: 'loading', isBuffering: true, error: null });

    try {
      await Promise.resolve(target.play());
      if (destroyed
        || attempt !== playAttemptGeneration
        || expectedSourceGeneration !== sourceGeneration) return;
      updateSnapshot({ status: 'playing', isBuffering: false, error: null });
    } catch (failure) {
      if (destroyed
        || attempt !== playAttemptGeneration
        || expectedSourceGeneration !== sourceGeneration) return;
      const code = classifyPlaybackFailure(failure);
      reportPlaybackError('play_call', code);
      updateSnapshot({
        status: code === 'autoplayBlocked' ? 'paused' : 'error',
        isBuffering: false,
        error: playerError(code)
      });
    }
  };

  const activateIndex = async (
    index: number,
    autoplay: boolean,
    orderPosition = playOrder.indexOf(index),
    navigationDirection: 'previous' | 'next' | null = null
  ): Promise<void> => {
    if (destroyed || index < 0 || index >= snapshot.queue.length) return;

    playOrderPosition = orderPosition;
    if (navigationDirection) recordNavigation(index, navigationDirection);

    sourceGeneration += 1;
    playAttemptGeneration += 1;
    const generation = sourceGeneration;
    const item = snapshot.queue[index];
    updateSnapshot({
      currentIndex: index,
      status: 'loading',
      isBuffering: true,
      currentTime: 0,
      duration: 0,
      error: null
    });

    if (!item.streamUrl.trim()) {
      reportPlaybackError('source_set', 'streamUnavailable');
      updateSnapshot({
        status: 'error',
        isBuffering: false,
        error: playerError('streamUnavailable')
      });
      return;
    }

    const target = ensureAudio();
    if (!target) {
      if (!destroyed && generation === sourceGeneration) {
        updateSnapshot({
          status: 'error',
          isBuffering: false,
          error: playerError('streamUnavailable')
        });
      }
      return;
    }
    if (destroyed || generation !== sourceGeneration) return;

    try {
      target.pause();
      target.src = item.streamUrl;
      target.currentTime = 0;
      target.load();
    } catch {
      reportPlaybackError('source_set', 'streamUnavailable');
      updateSnapshot({
        status: 'error',
        isBuffering: false,
        error: playerError('streamUnavailable')
      });
      return;
    }

    if (autoplay) {
      await attemptPlay(generation);
    } else if (!destroyed && generation === sourceGeneration) {
      updateSnapshot({ status: 'paused', error: null });
    }
  };

  const restartCurrent = async (autoplay: boolean): Promise<boolean> => {
    if (destroyed || !snapshot.currentItem) return false;
    const target = ensureAudio();
    if (!target) return false;

    try {
      target.currentTime = 0;
      updateSnapshot({ currentTime: 0 });
    } catch {
      return false;
    }

    if (autoplay) await attemptPlay(sourceGeneration);
    return true;
  };

  const moveToOrderPosition = async (
    destination: number,
    direction: 'previous' | 'next'
  ): Promise<boolean> => {
    if (destroyed || destination < 0 || destination >= playOrder.length) return false;
    await activateIndex(playOrder[destination], true, destination, direction);
    return true;
  };

  async function movePrevious(): Promise<boolean> {
    if (destroyed || !snapshot.currentItem) return false;
    if (snapshot.currentTime >= PREVIOUS_RESTART_SECONDS) {
      return restartCurrent(snapshot.status === 'ended');
    }
    if (playOrderPosition > 0) return moveToOrderPosition(playOrderPosition - 1, 'previous');
    if (snapshot.repeatMode === 'all' && playOrder.length > 1) {
      return moveToOrderPosition(playOrder.length - 1, 'previous');
    }
    return false;
  }

  async function moveNext(): Promise<boolean> {
    if (destroyed || !snapshot.currentItem) return false;
    if (playOrderPosition >= 0 && playOrderPosition < playOrder.length - 1) {
      return moveToOrderPosition(playOrderPosition + 1, 'next');
    }
    if (snapshot.repeatMode !== 'all' || playOrder.length <= 1) return false;
    actualHistory = [];
    actualHistoryPosition = -1;
    return moveToOrderPosition(0, 'next');
  }

  async function handleEnded(target: PlayerAudio): Promise<void> {
    if (!snapshot.currentItem || destroyed) return;
    const endedGeneration = sourceGeneration;
    const endedItem = snapshot.currentItem;
    if (snapshot.repeatMode === 'one'
      || (snapshot.repeatMode === 'all' && snapshot.queue.length === 1)) {
      if (await restartCurrent(true)) return;
      if (destroyed
        || sourceGeneration !== endedGeneration
        || snapshot.currentItem !== endedItem) return;
      updateSnapshot({
        status: 'ended',
        isBuffering: false,
        currentTime: snapshot.duration || readAudioTime(target)
      });
      return;
    }
    if (await moveNext()) return;
    if (destroyed
      || sourceGeneration !== endedGeneration
      || snapshot.currentItem !== endedItem) return;
    updateSnapshot({
      status: 'ended',
      isBuffering: false,
      currentTime: snapshot.duration || readAudioTime(target)
    });
  }

  const clearQueue = () => {
    sourceGeneration += 1;
    playAttemptGeneration += 1;
    playOrder = [];
    playOrderPosition = -1;
    actualHistory = [];
    actualHistoryPosition = -1;
    updateSnapshot({
      queue: Object.freeze([]) as readonly PlayerQueueItem[],
      currentIndex: -1,
      status: 'idle',
      isBuffering: false,
      currentTime: 0,
      duration: 0,
      error: null
    });

    if (!audio) return;
    try {
      audio.pause();
      audio.removeAttribute?.('src');
      audio.load();
    } catch {
      // Clearing playback remains best-effort for browser-specific audio implementations.
    }
  };

  /** Owns a source-neutral immutable queue launch shared by Albums and Playlists. */
  const launchQueue: PlayerStore['launchQueue'] = async (
    queue,
    initialIndex,
    launchOptions = {}
  ) => {
    if (destroyed) return;
    if (queue.length === 0) {
      clearQueue();
      return;
    }

    const ownedQueue = copyQueue(queue);
    const boundedIndex = clamp(
      Number.isFinite(initialIndex) ? Math.trunc(initialIndex) : 0,
      0,
      ownedQueue.length - 1
    );
    playOrder = launchOrder(ownedQueue.length, boundedIndex);
    playOrderPosition = playOrder.indexOf(boundedIndex);
    actualHistory = [boundedIndex];
    actualHistoryPosition = 0;
    updateSnapshot({
      queue: ownedQueue,
      currentIndex: boundedIndex,
      status: 'loading',
      isBuffering: true,
      currentTime: 0,
      duration: 0,
      error: null
    });
    await activateIndex(
      boundedIndex,
      launchOptions.autoplay ?? true,
      playOrderPosition
    );
  };

  const store: PlayerStore = {
    getSnapshot: () => snapshot,
    getServerSnapshot: () => snapshot,
    subscribe: (listener) => {
      if (destroyed) return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    launchQueue,
    launchAlbumQueue: launchQueue,
    launchStandalone: async (item, launchOptions = {}) => {
      if (destroyed) return;
      const ownedQueue = copyQueue([item]);
      playOrder = [0];
      playOrderPosition = 0;
      actualHistory = [0];
      actualHistoryPosition = 0;
      updateSnapshot({
        queue: ownedQueue,
        currentIndex: 0,
        status: 'loading',
        isBuffering: true,
        currentTime: 0,
        duration: 0,
        error: null
      });
      await activateIndex(0, launchOptions.autoplay ?? true, 0);
    },
    play: async () => {
      if (destroyed || !snapshot.currentItem) return;
      const target = ensureAudio();
      if (!target) return;
      if (snapshot.status === 'playing' && !target.paused) return;

      if (snapshot.status === 'ended') {
        try {
          target.currentTime = 0;
          updateSnapshot({ currentTime: 0 });
        } catch {
          // A source that cannot be repositioned can still attempt normal playback.
        }
      }

      if (snapshot.status === 'error') {
        try {
          target.load();
        } catch {
          reportPlaybackError('source_set', 'streamUnavailable');
          updateSnapshot({
            status: 'error',
            isBuffering: false,
            error: playerError('streamUnavailable')
          });
          return;
        }
      }

      await attemptPlay(sourceGeneration);
    },
    pause: () => {
      if (destroyed || !snapshot.currentItem) return;
      if (snapshot.status === 'error' || snapshot.status === 'ended') return;
      playAttemptGeneration += 1;
      try {
        audio?.pause();
      } catch {
        // The visible state can still pause even if a browser audio shim rejects the call.
      }
      updateSnapshot({ status: 'paused', isBuffering: false });
    },
    previous: () => movePrevious(),
    next: () => moveNext(),
    seek: (time) => {
      if (destroyed || !audio || !snapshot.currentItem || !Number.isFinite(time)) return;
      const upperBound = snapshot.duration > 0 ? snapshot.duration : Number.MAX_SAFE_INTEGER;
      const position = clamp(time, 0, upperBound);
      try {
        audio.currentTime = position;
        updateSnapshot({ currentTime: position });
      } catch {
        // Some streams reject seeking until metadata arrives; later attempts remain valid.
      }
    },
    skipBackward: (seconds = DEFAULT_SKIP_SECONDS) => {
      if (!Number.isFinite(seconds)) return;
      store.seek(snapshot.currentTime - Math.max(0, seconds));
    },
    skipForward: (seconds = DEFAULT_SKIP_SECONDS) => {
      if (!Number.isFinite(seconds)) return;
      store.seek(snapshot.currentTime + Math.max(0, seconds));
    },
    toggleShuffle: () => {
      if (destroyed) return;
      const shuffleEnabled = !snapshot.shuffleEnabled;

      if (snapshot.currentItem) {
        if (shuffleEnabled) {
          const history = currentCycleHistory();
          const visited = new Set(history);
          const remaining = canonicalOrder(snapshot.queue.length)
            .filter((index) => !visited.has(index));
          playOrder = [...history, ...shuffled(remaining)];
          playOrderPosition = history.length - 1;
        } else {
          playOrder = canonicalOrder(snapshot.queue.length);
          playOrderPosition = snapshot.currentIndex;
        }
      }

      updateSnapshot({ shuffleEnabled });
    },
    cycleRepeatMode: () => {
      if (destroyed) return;
      const repeatMode: PlayerRepeatMode = snapshot.repeatMode === 'off'
        ? 'all'
        : snapshot.repeatMode === 'all' ? 'one' : 'off';
      updateSnapshot({ repeatMode });
    },
    setVolume: (volume) => {
      if (destroyed || !Number.isFinite(volume)) return;
      const nextVolume = clamp(volume, 0, 1);
      if (audio) {
        try {
          audio.volume = nextVolume;
        } catch {
          return;
        }
      }
      updateSnapshot({ volume: nextVolume });
    },
    setMuted: (muted) => {
      if (destroyed) return;
      if (audio) {
        try {
          audio.muted = muted;
        } catch {
          return;
        }
      }
      updateSnapshot({ muted });
    },
    toggleMute: () => store.setMuted(!snapshot.muted),
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      sourceGeneration += 1;
      playAttemptGeneration += 1;
      snapshot = initialSnapshot(
        snapshot.volume,
        snapshot.muted,
        snapshot.shuffleEnabled,
        snapshot.repeatMode
      );
      notify();

      if (audio) {
        boundAudioListeners.forEach((listener, event) => {
          audio?.removeEventListener(event, listener);
        });
        try {
          audio.pause();
          audio.removeAttribute?.('src');
          audio.load();
        } catch {
          // Teardown is best-effort and the detached element is never reused.
        }
      }

      if (mediaSession) {
        registeredMediaActions.forEach((action) => {
          try {
            mediaSession.setActionHandler(action, null);
          } catch {
            // Unsupported handlers are safely ignored.
          }
        });
        try {
          mediaSession.metadata = null;
          mediaSession.playbackState = 'none';
          mediaSession.setPositionState?.();
        } catch {
          // Media Session teardown is optional.
        }
      }

      listeners.clear();
      boundAudioListeners.clear();
      audio = null;
    }
  };

  const mediaHandlers: Record<PlayerMediaSessionAction, (
    details: { seekOffset?: number; seekTime?: number }
  ) => void> = {
    play: () => { void store.play(); },
    pause: () => store.pause(),
    previoustrack: () => { void store.previous(); },
    nexttrack: () => { void store.next(); },
    seekbackward: ({ seekOffset }) => store.skipBackward(seekOffset),
    seekforward: ({ seekOffset }) => store.skipForward(seekOffset),
    seekto: ({ seekTime }) => {
      if (typeof seekTime === 'number') store.seek(seekTime);
    }
  };

  if (mediaSession) {
    (Object.entries(mediaHandlers) as Array<[
      PlayerMediaSessionAction,
      (details: { seekOffset?: number; seekTime?: number }) => void
    ]>).forEach(([action, handler]) => {
      try {
        mediaSession.setActionHandler(action, handler);
        registeredMediaActions.add(action);
      } catch {
        // Browsers may expose Media Session while omitting individual actions.
      }
    });
    syncMediaSession();
  }

  return store;
};

/** Shared browser runtime; its audio element is created lazily on first launch. */
export const playerStore = createPlayerStore({
  onPlaybackError: (event) => {
    enqueueListenerTelemetry({
      category: 'playback_error',
      route: classifyListenerRoute(
        typeof window === 'undefined' ? '/finitude' : window.location.pathname
      ),
      ...event
    });
  }
});
