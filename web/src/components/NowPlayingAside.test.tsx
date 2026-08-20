import { act, render, screen, within } from '@testing-library/react';

import { createPlayerStore } from '../player';
import type { PlayerAudio, PlayerQueueItem, PlayerStore } from '../player';
import { NowPlayingAside } from './NowPlayingAside';

class AsideAudio implements PlayerAudio {
  src = '';
  currentTime = 0;
  duration = 180;
  volume = 1;
  muted = false;
  paused = true;
  ended = false;
  error = null;
  playbackRate = 1;
  preload = '';
  private readonly listeners = new Map<string, Set<() => void>>();
  async play(): Promise<void> { this.paused = false; this.emit('playing'); }
  pause(): void { this.paused = true; this.emit('pause'); }
  load(): void {}
  addEventListener(type: string, listener: () => void): void {
    const group = this.listeners.get(type) ?? new Set();
    group.add(listener);
    this.listeners.set(type, group);
  }
  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  emit(type: string): void { this.listeners.get(type)?.forEach((listener) => listener()); }
}

const tracks: PlayerQueueItem[] = [
  {
    id: 'current',
    title: 'Still Water',
    artworkUrl: '/art/still-water.jpg',
    artistNames: ['Aster Vale'],
    mediaType: 'audio',
    streamUrl: '/audio/still-water.mp3'
  },
  {
    id: 'next',
    title: 'Open Field',
    artworkUrl: '/art/open-field.jpg',
    artistNames: ['June North'],
    mediaType: 'audio',
    streamUrl: '/audio/open-field.mp3'
  }
];

const stores: PlayerStore[] = [];

afterEach(() => {
  act(() => stores.splice(0).forEach((store) => store.destroy()));
});

test('renders a quiet read-only state until the shared player has a current soundtrack', () => {
  const store = createPlayerStore({ audioFactory: () => new AsideAudio(), mediaSession: null });
  stores.push(store);
  render(<NowPlayingAside store={store} />);

  const panel = screen.getByRole('region', { name: 'Current MediaTrack' });
  expect(panel).toHaveTextContent('Nothing playing');
  expect(within(panel).queryByRole('button')).not.toBeInTheDocument();
});

test('shows only current metadata and the store-derived effective next item', async () => {
  const store = createPlayerStore({ audioFactory: () => new AsideAudio(), mediaSession: null });
  stores.push(store);
  await store.launchQueue(tracks, 0, { autoplay: false });
  render(<NowPlayingAside store={store} />);

  const aside = screen.getByRole('region', { name: 'Current MediaTrack' });
  expect(within(aside).getAllByText('Still Water')).toHaveLength(2);
  expect(within(aside).getByText('Aster Vale')).toBeInTheDocument();
  const upNext = within(aside).getByRole('region', { name: 'Up next' });
  expect(within(upNext).getByText('Open Field')).toBeInTheDocument();
  expect(within(upNext).getByText('June North')).toBeInTheDocument();
  expect(within(aside).queryByRole('button')).not.toBeInTheDocument();
});

test('labels the current soundtrack honestly when Repeat One is effective', async () => {
  const store = createPlayerStore({ audioFactory: () => new AsideAudio(), mediaSession: null });
  stores.push(store);
  await store.launchQueue(tracks, 0, { autoplay: false });
  store.cycleRepeatMode();
  store.cycleRepeatMode();
  render(<NowPlayingAside store={store} />);

  expect(screen.getByRole('region', { name: 'Repeats next' })).toHaveTextContent('Still Water');
});

test('a Video MediaTrack shows the playback queue and no media-mode switch', async () => {
  const audio = new AsideAudio();
  const audioFactory = vi.fn(() => audio);
  const store = createPlayerStore({ audioFactory, mediaSession: null });
  stores.push(store);
  await store.launchQueue([
    { ...tracks[0], mediaType: 'video', streamUrl: '/video/still-water.mp4' },
    tracks[1]
  ], 0, { autoplay: false });
  render(<NowPlayingAside store={store} />);

  const queue = screen.getByRole('region', { name: 'Video playback queue' });
  expect(within(queue).getByRole('heading', { name: 'Up next' })).toBeInTheDocument();
  expect(within(queue).getByText('Open Field')).toBeInTheDocument();
  expect(within(queue).queryByRole('group', { name: 'Playback media' })).not.toBeInTheDocument();
  expect(audio.src).toBe('/video/still-water.mp4');
  expect(audioFactory).toHaveBeenCalledTimes(1);
});
