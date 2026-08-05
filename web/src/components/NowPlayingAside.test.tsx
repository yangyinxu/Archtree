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
  async play(): Promise<void> { this.paused = false; }
  pause(): void { this.paused = true; }
  load(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

const tracks: PlayerQueueItem[] = [
  {
    id: 'current',
    title: 'Still Water',
    artworkUrl: '/art/still-water.jpg',
    artistNames: ['Aster Vale'],
    streamUrl: '/audio/still-water.mp3'
  },
  {
    id: 'next',
    title: 'Open Field',
    artworkUrl: '/art/open-field.jpg',
    artistNames: ['June North'],
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

  const panel = screen.getByRole('region', { name: 'Current soundtrack' });
  expect(panel).toHaveTextContent('Nothing playing');
  expect(within(panel).queryByRole('button')).not.toBeInTheDocument();
});

test('shows only current metadata and the store-derived effective next item', async () => {
  const store = createPlayerStore({ audioFactory: () => new AsideAudio(), mediaSession: null });
  stores.push(store);
  await store.launchAlbumQueue(tracks, 0, { autoplay: false });
  render(<NowPlayingAside store={store} />);

  const aside = screen.getByRole('region', { name: 'Current soundtrack' });
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
  await store.launchAlbumQueue(tracks, 0, { autoplay: false });
  store.cycleRepeatMode();
  store.cycleRepeatMode();
  render(<NowPlayingAside store={store} />);

  expect(screen.getByRole('region', { name: 'Repeats next' })).toHaveTextContent('Still Water');
});
