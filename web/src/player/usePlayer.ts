import { useSyncExternalStore } from 'react';

import { playerStore } from './playerStore';
import type { PlayerStore } from './types';

/** Subscribes React surfaces to the same route-independent player snapshot. */
export const usePlayer = (store: PlayerStore = playerStore) =>
  useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
