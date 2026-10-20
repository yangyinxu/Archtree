import { useSyncExternalStore } from 'react';

import { playerStore } from './playerStore';
import type { PlayerSnapshot, PlayerStore } from './types';

/** Subscribes React surfaces to the same route-independent player snapshot. */
export const usePlayer = (store: PlayerStore = playerStore) =>
  useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);

const playingTrackId = (snapshot: PlayerSnapshot) => (
  snapshot.status === 'playing' ? snapshot.currentItem?.id ?? null : null
);

/** Subscribes to the actively playing MediaTrack ID without repainting on every clock tick. */
export const usePlayingTrackId = (store: PlayerStore = playerStore) => useSyncExternalStore(
  store.subscribe,
  () => playingTrackId(store.getSnapshot()),
  () => playingTrackId(store.getServerSnapshot())
);
