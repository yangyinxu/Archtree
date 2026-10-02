import { useMemo, useSyncExternalStore } from 'react';

import { playerStore } from './playerStore';
import type { PlayerSnapshot, PlayerStore } from './types';

type PlayerQueueSnapshot = Pick<PlayerSnapshot, 'currentItem' | 'upNextItem' | 'upNextItems' | 'shuffleEnabled'>;

/** Lazy queue surfaces receive metadata/order changes without rendering every elapsed-clock tick. */
export const usePlayerQueue = (store: PlayerStore = playerStore): PlayerQueueSnapshot => {
  const readQueue = useMemo(() => {
    let selected: PlayerQueueSnapshot | undefined;
    return () => {
      const current = store.getSnapshot();
      if (selected?.currentItem === current.currentItem
        && selected.upNextItem === current.upNextItem
        && selected.upNextItems === current.upNextItems
        && selected.shuffleEnabled === current.shuffleEnabled) return selected;
      selected = { currentItem: current.currentItem, upNextItem: current.upNextItem,
        upNextItems: current.upNextItems, shuffleEnabled: current.shuffleEnabled };
      return selected;
    };
  }, [store]);
  return useSyncExternalStore(store.subscribe, readQueue, readQueue);
};
