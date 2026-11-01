import { useMemo, useRef, useSyncExternalStore } from 'react';

import { playerStore } from './playerStore';
import type { PlayerSnapshot, PlayerStore } from './types';

/** How the shared player relates to one page's ordered queue (an Album or a Playlist's ready members). */
export interface PlaybackContext {
  currentId: string | null;
  status: 'playing' | 'paused' | null;
  /** True when the local player queue holds exactly this page's MediaTracks in this order. */
  matches: boolean;
}

/**
 * Narrow player selector for a page's queue: re-renders on status, current item or queue changes,
 * never on clock ticks. Imported by path (not from `player/index.ts`) so it stays out of the shell.
 */
export const usePlaybackContext = (
  trackIds: readonly string[],
  store: PlayerStore = playerStore
): PlaybackContext => {
  const cache = useRef<{ queue?: PlayerSnapshot['queue']; ids?: readonly string[]; matches: boolean }>({ matches: false });
  // A string key keeps the snapshot stable across unrelated store updates such as currentTime.
  const select = (snapshot: PlayerSnapshot) => {
    // Matching IDs do not authorize ordinary page actions to control a listening room.
    if (store.isRoomPlaybackActive()) return '0||';
    const memo = cache.current;
    if (memo.queue !== snapshot.queue || memo.ids !== trackIds) {
      cache.current = {
        queue: snapshot.queue,
        ids: trackIds,
        matches: snapshot.queue.length === trackIds.length
          && snapshot.queue.every((item, index) => item.id === trackIds[index])
      };
    }
    const status = snapshot.status === 'playing' || snapshot.status === 'paused' ? snapshot.status : '';
    return `${cache.current.matches ? 1 : 0}|${status}|${snapshot.currentItem?.id ?? ''}`;
  };
  const key = useSyncExternalStore(
    store.subscribe,
    () => select(store.getSnapshot()),
    () => select(store.getServerSnapshot())
  );
  return useMemo(() => {
    const [matches, status, ...id] = key.split('|');
    return {
      matches: matches === '1',
      status: (status || null) as PlaybackContext['status'],
      currentId: id.join('|') || null
    };
  }, [key]);
};
