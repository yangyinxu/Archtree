import { act, renderHook } from '@testing-library/react';

import { createPlayerStore } from './playerStore';
import type { PlayerAudio, PlayerQueueItem } from './types';
import { usePlayer } from './usePlayer';
import { usePlayerQueue } from './usePlayerQueue';

class QuietAudio implements PlayerAudio {
  src = '';
  currentTime = 0;
  duration = 0;
  volume = 1;
  muted = false;
  paused = true;
  ended = false;
  error = null;
  playbackRate = 1;
  private readonly listeners = new Map<string, Set<() => void>>();

  async play(): Promise<void> {
    this.paused = false;
    this.listeners.get('playing')?.forEach((listener) => listener());
  }

  pause(): void {
    this.paused = true;
  }

  load(): void {}

  addEventListener(type: string, listener: () => void): void {
    const group = this.listeners.get(type) ?? new Set();
    group.add(listener);
    this.listeners.set(type, group);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string): void {
    this.listeners.get(type)?.forEach((listener) => listener());
  }
}

const item: PlayerQueueItem = {
  id: 'hook-track',
  title: 'Shared State',
  artworkUrl: '',
  artistNames: ['Finitude'],
  mediaType: 'audio',
  streamUrl: '/audio/shared-state.mp3'
};

test('subscribes React to the same external player snapshot', async () => {
  const store = createPlayerStore({ audioFactory: () => new QuietAudio(), mediaSession: null });
  const { result } = renderHook(() => usePlayer(store));
  expect(result.current.status).toBe('idle');

  await act(async () => {
    await store.launchStandalone(item);
  });

  expect(result.current).toMatchObject({
    status: 'playing',
    currentItem: { id: 'hook-track', title: 'Shared State' }
  });
});

test('queue subscribers skip clock/transport renders while full subscribers preserve progress and controls', async () => {
  const audio = new QuietAudio();
  const store = createPlayerStore({ audioFactory: () => audio, mediaSession: null });
  await store.launchQueue([item, { ...item, id: 'next-track' }], 0, { autoplay: false });
  let queueRenders = 0;
  const queue = renderHook(() => { queueRenders += 1; return usePlayerQueue(store); });
  const clock = renderHook(() => usePlayer(store));
  const selected = queue.result.current;
  const initialRenders = queueRenders;

  act(() => { audio.currentTime = 2.9; audio.emit('timeupdate'); });
  expect(clock.result.current.canPrevious).toBe(false);
  act(() => { audio.currentTime = 3; audio.emit('timeupdate'); });
  expect(clock.result.current.canPrevious).toBe(true);
  await act(async () => { await store.play(); });
  expect(clock.result.current.status).toBe('playing');
  act(() => { store.pause(); });
  expect(clock.result.current.status).toBe('paused');
  expect(clock.result.current.currentTime).toBe(3);
  expect(queue.result.current).toBe(selected);
  expect(queueRenders).toBe(initialRenders);

  act(() => { store.cycleRepeatMode(); store.cycleRepeatMode(); });
  expect(queue.result.current.upNextItem?.id).toBe(item.id);
  expect(queue.result.current).not.toBe(selected);
  queue.unmount(); clock.unmount(); store.destroy();
});

test('changing the injected store replaces queue context and unsubscribes the previous player', async () => {
  const oldAudio = new QuietAudio();
  const oldStore = createPlayerStore({ audioFactory: () => oldAudio, mediaSession: null });
  const nextStore = createPlayerStore({ audioFactory: () => new QuietAudio(), mediaSession: null });
  await oldStore.launchStandalone(item, { autoplay: false });
  await nextStore.launchStandalone({ ...item, id: 'replacement', title: 'Replacement' }, { autoplay: false });
  const { result, rerender, unmount } = renderHook(({ store }) => usePlayerQueue(store), { initialProps: { store: oldStore } });
  expect(result.current.currentItem?.id).toBe(item.id);
  rerender({ store: nextStore });
  expect(result.current.currentItem?.id).toBe('replacement');
  const replacement = result.current;
  act(() => { oldStore.cycleRepeatMode(); });
  expect(result.current).toBe(replacement);
  unmount(); oldStore.destroy(); nextStore.destroy();
});
