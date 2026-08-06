import { act, renderHook } from '@testing-library/react';

import { createPlayerStore } from './playerStore';
import type { PlayerAudio, PlayerQueueItem } from './types';
import { usePlayer } from './usePlayer';

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
}

const item: PlayerQueueItem = {
  id: 'hook-track',
  title: 'Shared State',
  artworkUrl: '',
  artistNames: ['Finitude'],
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
