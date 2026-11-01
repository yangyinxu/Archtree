import { act, renderHook } from '@testing-library/react';

import { createPlayerStore } from './playerStore';
import type { PlayerQueueItem, PlayerSnapshot, PlayerStore } from './types';
import { usePlaybackContext } from './usePlaybackContext';

const item = (id: string): PlayerQueueItem => ({
  id,
  title: id,
  artworkUrl: '',
  artistNames: ['Finitude'],
  mediaType: 'audio',
  streamUrl: `/content/mediaTrack/stream/${id}`
});

/** A minimal store whose snapshot each test replaces by hand. */
const fakeStore = (initial: Partial<PlayerSnapshot>) => {
  const base = createPlayerStore().getSnapshot();
  let snapshot: PlayerSnapshot = { ...base, ...initial };
  const listeners = new Set<() => void>();
  const store = {
    ...createPlayerStore(),
    getSnapshot: () => snapshot,
    getServerSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  } as PlayerStore;
  const update = (patch: Partial<PlayerSnapshot>) => act(() => {
    snapshot = { ...snapshot, ...patch };
    listeners.forEach((listener) => listener());
  });
  return { store, update };
};

const first = item('first');
const second = item('second');
const pageIds = ['first', 'second'];

test('matches the page only when the player queue holds its ids in order', () => {
  const { store, update } = fakeStore({ queue: [first, second], currentItem: first, status: 'playing' });
  const { result } = renderHook(() => usePlaybackContext(pageIds, store));
  expect(result.current).toEqual({ matches: true, status: 'playing', currentId: 'first' });

  update({ queue: [second, first] });
  expect(result.current.matches).toBe(false);
  update({ queue: [first] });
  expect(result.current.matches).toBe(false);
});

test('reports paused and playing, and nothing while idle', () => {
  const { store, update } = fakeStore({ queue: [first, second], currentItem: second, status: 'paused' });
  const { result } = renderHook(() => usePlaybackContext(pageIds, store));
  expect(result.current).toEqual({ matches: true, status: 'paused', currentId: 'second' });

  update({ status: 'playing' });
  expect(result.current.status).toBe('playing');
  update({ status: 'idle', currentItem: null, queue: [] });
  expect(result.current).toEqual({ matches: false, status: null, currentId: null });
});

test('a clock-only snapshot change does not re-render the page', () => {
  const { store, update } = fakeStore({ queue: [first, second], currentItem: first, status: 'playing' });
  let renders = 0;
  renderHook(() => {
    renders += 1;
    return usePlaybackContext(pageIds, store);
  });
  const settled = renders;

  update({ currentTime: 12 });
  update({ currentTime: 13, duration: 200 });
  expect(renders).toBe(settled);

  update({ status: 'paused' });
  expect(renders).toBe(settled + 1);
});
