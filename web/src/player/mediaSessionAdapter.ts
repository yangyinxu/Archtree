import { mediaSessionArtworkSources } from '../artwork/artworkUrls';
import type {
  CreatePlayerStoreOptions,
  PlayerAudio,
  PlayerMediaSession,
  PlayerMediaSessionAction,
  PlayerMediaSessionActionDetails,
  PlayerQueueItem,
  PlayerSnapshot,
  PlayerStore
} from './types';

/** Optional browser integration never owns playback state or another queue. */
export const createMediaSessionAdapter = (options: CreatePlayerStoreOptions) => {
  const session: PlayerMediaSession | null = options.mediaSession === undefined
    ? typeof navigator !== 'undefined' && 'mediaSession' in navigator
      ? navigator.mediaSession as unknown as PlayerMediaSession
      : null
    : options.mediaSession;
  const metadataFactory = options.mediaMetadataFactory ?? ((metadata) => (
    typeof MediaMetadata === 'undefined' ? metadata : new MediaMetadata(metadata)
  ));
  const registeredActions = new Set<PlayerMediaSessionAction>();
  let lastItem: PlayerQueueItem | null | undefined;

  return {
    /** Publishes one store snapshot without allowing browser failures back into transport. */
    sync(snapshot: PlayerSnapshot, audio: PlayerAudio | null) {
      if (!session) return;
      if (snapshot.currentItem !== lastItem) {
        lastItem = snapshot.currentItem;
        try {
          session.metadata = snapshot.currentItem ? metadataFactory({
            title: snapshot.currentItem.title,
            artist: snapshot.currentItem.displayByline || snapshot.currentItem.artistNames.join(', '),
            artwork: mediaSessionArtworkSources(snapshot.currentItem.artworkUrl)
          }) : null;
        } catch {
          // Metadata support is independent from transport support.
        }
      }
      try {
        session.playbackState = snapshot.currentItem === null
          ? 'none' : snapshot.status === 'playing' ? 'playing' : 'paused';
      } catch {
        // Some browsers expose a read-only playback state.
      }
      try {
        if (snapshot.currentItem && snapshot.duration > 0 && Number.isFinite(snapshot.duration)) {
          session.setPositionState?.({
            duration: snapshot.duration,
            playbackRate: audio && Number.isFinite(audio.playbackRate) && audio.playbackRate > 0
              ? audio.playbackRate : 1,
            position: Math.min(Math.max(snapshot.currentTime, 0), snapshot.duration)
          });
        } else {
          session.setPositionState?.();
        }
      } catch {
        // Position support varies independently across implementations.
      }
    },
    /** System controls invoke the same public commands as in-page controls. */
    register(store: PlayerStore) {
      if (!session) return;
      const handlers: Record<PlayerMediaSessionAction, (details: PlayerMediaSessionActionDetails) => void> = {
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
      for (const [action, handler] of Object.entries(handlers)) {
        try {
          session.setActionHandler(action as PlayerMediaSessionAction, handler);
          registeredActions.add(action as PlayerMediaSessionAction);
        } catch {
          // Browsers may omit individual actions even when Media Session exists.
        }
      }
    },
    /** Removes only handlers installed by this adapter when its owning store is destroyed. */
    destroy() {
      if (!session) return;
      for (const action of registeredActions) {
        try { session.setActionHandler(action, null); } catch { /* Unsupported action. */ }
      }
      registeredActions.clear();
      try {
        session.metadata = null;
        session.playbackState = 'none';
        session.setPositionState?.();
      } catch {
        // Teardown remains optional and cannot prevent media-element disposal.
      }
      lastItem = undefined;
    }
  };
};
