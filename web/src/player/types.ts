import type { MediaSessionArtworkSource } from '../artwork/artworkUrls';

/** Canonical metadata retained for every item in the one shared playback queue. */
export interface PlayerQueueItem {
  id: string;
  title: string;
  artworkUrl: string;
  artistNames: readonly string[];
  streamUrl: string;
}

export type PlayerStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error';

export type PlayerRepeatMode = 'off' | 'all' | 'one';

export type PlayerErrorCode =
  | 'autoplayBlocked'
  | 'network'
  | 'decode'
  | 'streamUnavailable'
  | 'unknown';

/** Provides stable, user-safe failure state while retaining the queue for retry. */
export interface PlayerErrorState {
  code: PlayerErrorCode;
  message: string;
  recoverable: true;
}

export type PlayerPlaybackErrorStage =
  | 'audio_create'
  | 'source_set'
  | 'play_call'
  | 'media_element';

/** Anonymous playback failure dimension emitted without queue or content metadata. */
export interface PlayerPlaybackErrorEvent {
  stage: PlayerPlaybackErrorStage;
  code: PlayerErrorCode;
}

/** Immutable snapshot consumed by React and non-React player surfaces. */
export interface PlayerSnapshot {
  queue: readonly PlayerQueueItem[];
  currentIndex: number;
  currentItem: PlayerQueueItem | null;
  /** Item natural completion will make current, including Shuffle and Repeat semantics. */
  upNextItem: PlayerQueueItem | null;
  status: PlayerStatus;
  isBuffering: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  muted: boolean;
  shuffleEnabled: boolean;
  repeatMode: PlayerRepeatMode;
  error: PlayerErrorState | null;
  canPrevious: boolean;
  canNext: boolean;
}

export interface PlayerLaunchOptions {
  autoplay?: boolean;
}

/** Minimal audio boundary implemented by HTMLAudioElement and deterministic test fakes. */
export interface PlayerAudio {
  src: string;
  readonly currentSrc?: string;
  currentTime: number;
  readonly duration: number;
  volume: number;
  muted: boolean;
  readonly paused: boolean;
  readonly ended: boolean;
  readonly error: { code: number } | null;
  readonly playbackRate: number;
  preload?: string;
  play(): Promise<void>;
  pause(): void;
  load(): void;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
  removeAttribute?(name: string): void;
}

export type PlayerMediaSessionAction =
  | 'play'
  | 'pause'
  | 'previoustrack'
  | 'nexttrack'
  | 'seekbackward'
  | 'seekforward'
  | 'seekto';

export interface PlayerMediaSessionActionDetails {
  seekOffset?: number;
  seekTime?: number;
}

/** Narrow Media Session boundary so unsupported browsers can remain no-ops. */
export interface PlayerMediaSession {
  metadata: unknown;
  playbackState: 'none' | 'paused' | 'playing';
  setActionHandler(
    action: PlayerMediaSessionAction,
    handler: ((details: PlayerMediaSessionActionDetails) => void) | null
  ): void;
  setPositionState?(state?: {
    duration: number;
    playbackRate: number;
    position: number;
  }): void;
}

export interface CreatePlayerStoreOptions {
  audioFactory?: () => PlayerAudio;
  mediaSession?: PlayerMediaSession | null;
  mediaMetadataFactory?: (metadata: {
    title: string;
    artist: string;
    artwork: MediaSessionArtworkSource[];
  }) => unknown;
  initialVolume?: number;
  initiallyMuted?: boolean;
  initiallyShuffleEnabled?: boolean;
  initialRepeatMode?: PlayerRepeatMode;
  random?: () => number;
  onPlaybackError?: (event: PlayerPlaybackErrorEvent) => void;
}

/** Public commands intentionally contain no routing or activity-reporting dependency. */
export interface PlayerStore {
  getSnapshot(): PlayerSnapshot;
  getServerSnapshot(): PlayerSnapshot;
  subscribe(listener: () => void): () => void;
  launchAlbumQueue(
    queue: readonly PlayerQueueItem[],
    initialIndex: number,
    options?: PlayerLaunchOptions
  ): Promise<void>;
  launchStandalone(item: PlayerQueueItem, options?: PlayerLaunchOptions): Promise<void>;
  play(): Promise<void>;
  pause(): void;
  previous(): Promise<boolean>;
  next(): Promise<boolean>;
  seek(time: number): void;
  skipBackward(seconds?: number): void;
  skipForward(seconds?: number): void;
  toggleShuffle(): void;
  cycleRepeatMode(): void;
  setVolume(volume: number): void;
  setMuted(muted: boolean): void;
  toggleMute(): void;
  destroy(): void;
}
