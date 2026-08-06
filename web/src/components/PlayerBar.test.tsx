import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { createPlayerStore } from '../player';
import type { PlayerAudio, PlayerQueueItem, PlayerStore } from '../player';
import { PlayerBar } from './PlayerBar';

class PlayerBarAudio implements PlayerAudio {
  src = '';
  currentTime = 30;
  duration = 180;
  volume = 1;
  muted = false;
  paused = true;
  ended = false;
  error = null;
  playbackRate = 1;
  preload = '';
  private readonly listeners = new Map<string, Set<() => void>>();

  async play(): Promise<void> {
    this.paused = false;
    this.emit('playing');
  }

  pause(): void {
    this.paused = true;
    this.emit('pause');
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

  /** Emits deterministic metadata and playback events for the presentation tests. */
  emit(type: string): void {
    this.listeners.get(type)?.forEach((listener) => listener());
  }
}

const tracks: PlayerQueueItem[] = [
  {
    id: 'track-1',
    title: 'Still Water',
    artworkUrl: '/content/images/0123456789abcdef01234567',
    artistNames: ['Aster Vale'],
    streamUrl: '/audio/still-water.mp3'
  },
  {
    id: 'track-2',
    title: 'Open Field',
    artworkUrl: '/art/open-field.jpg',
    artistNames: ['June North'],
    streamUrl: '/audio/open-field.mp3'
  }
];

class PlayerBarPointerEvent extends MouseEvent {
  readonly pointerId: number;
  readonly pointerType: string;

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? '';
  }
}

const setMobileViewport = (matches: boolean) => {
  vi.stubGlobal('PointerEvent', PlayerBarPointerEvent);
  vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
    matches: query === '(max-width: 767px)' ? matches : false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn()
  })));
};

const stores: PlayerStore[] = [];

const playerFixture = async (initialIndex = 0) => {
  const audio = new PlayerBarAudio();
  const audioFactory = vi.fn(() => audio);
  const store = createPlayerStore({ audioFactory, mediaSession: null });
  stores.push(store);
  await store.launchAlbumQueue(tracks, initialIndex, { autoplay: false });
  audio.currentTime = 30;
  audio.emit('durationchange');
  audio.emit('timeupdate');
  return { audio, audioFactory, store };
};

afterEach(() => {
  act(() => stores.splice(0).forEach((store) => store.destroy()));
});

test('opens and closes the mobile expanded surface without creating another player', async () => {
  setMobileViewport(true);
  const user = userEvent.setup();
  const { audioFactory, store } = await playerFixture();
  render(<PlayerBar store={store} />);

  const compactArtwork = screen
    .getByRole('button', { name: 'Open Now Playing: Still Water' })
    .querySelector('img');
  expect(compactArtwork).toHaveAttribute('sizes', '(max-width: 767px) 2.55rem, 3.4rem');
  await user.click(screen.getByRole('button', { name: 'Open Now Playing: Still Water' }));
  const expanded = screen.getByRole('dialog', { name: 'Still Water' });
  expect(document.querySelector('section[aria-label="Now playing"]')).toHaveAttribute('inert');

  expect(within(expanded).getByRole('img', { name: 'Still Water cover' }))
    .toHaveAttribute(
      'sizes',
      '(max-width: 767px) and (orientation: landscape) and (max-height: 500px) min(32vh, 14rem), min(72vw, 22rem)'
    );
  expect(within(expanded).getByRole('button', { name: 'Shuffle off. Turn shuffle on' }))
    .toHaveAttribute('aria-pressed', 'false');
  expect(within(expanded).getByRole('button', { name: 'Repeat off. Turn on repeat all' }))
    .toHaveAttribute('aria-pressed', 'false');
  expect(within(expanded).getByRole('slider', { name: 'Volume' })).toHaveValue('1');

  await user.click(within(expanded).getByRole('button', { name: 'Shuffle off. Turn shuffle on' }));
  expect(store.getSnapshot().shuffleEnabled).toBe(true);
  await user.click(within(expanded).getByRole('button', { name: 'Repeat off. Turn on repeat all' }));
  expect(store.getSnapshot().repeatMode).toBe('all');
  expect(within(expanded).getByRole('button', { name: 'Repeat all enabled. Turn on repeat one' }))
    .toHaveAttribute('aria-pressed', 'true');

  await user.click(within(expanded).getByRole('button', { name: 'Close expanded player' }));
  expect(screen.queryByRole('dialog', { name: 'Still Water' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Open Now Playing: Still Water' })).toHaveAttribute('aria-expanded', 'false');
  expect(store.getSnapshot().currentItem?.id).toBe('track-1');
  expect(audioFactory).toHaveBeenCalledTimes(1);
});

test('keeps a mouse tap on the compact identity button instead of capturing it as a swipe', async () => {
  setMobileViewport(true);
  const user = userEvent.setup();
  const { store } = await playerFixture();
  render(<PlayerBar store={store} />);
  const compact = screen.getByRole('region', { name: 'Now playing' });
  const capturePointer = vi.fn();
  Object.defineProperty(compact, 'setPointerCapture', { value: capturePointer });

  await user.click(screen.getByRole('button', { name: 'Open Now Playing: Still Water' }));

  expect(capturePointer).not.toHaveBeenCalled();
  expect(screen.getByRole('dialog', { name: 'Still Water' })).toBeInTheDocument();
});

test('handles conservative vertical and horizontal compact-player gestures', async () => {
  setMobileViewport(true);
  const { audioFactory, store } = await playerFixture();
  render(<PlayerBar store={store} />);
  const compact = screen.getByRole('region', { name: 'Now playing' });
  const capturePointer = vi.fn();
  Object.defineProperty(compact, 'setPointerCapture', { value: capturePointer });

  fireEvent.pointerDown(compact, { button: 0, clientX: 120, clientY: 140, pointerType: 'touch' });
  expect(capturePointer).not.toHaveBeenCalled();
  fireEvent.pointerMove(compact, { button: 0, clientX: 118, clientY: 80, pointerType: 'touch' });
  expect(capturePointer).toHaveBeenCalledWith(1);
  fireEvent.pointerUp(compact, { button: 0, clientX: 116, clientY: 72, pointerType: 'touch' });
  expect(screen.getByRole('dialog', { name: 'Still Water' })).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Close expanded player' }));
  capturePointer.mockClear();
  fireEvent.pointerDown(compact, { button: 0, clientX: 170, clientY: 80, pointerType: 'touch' });
  expect(capturePointer).not.toHaveBeenCalled();
  fireEvent.pointerMove(compact, { button: 0, clientX: 120, clientY: 83, pointerType: 'touch' });
  expect(capturePointer).toHaveBeenCalledWith(1);
  expect(compact.style.getPropertyValue('--compact-swipe-x')).toBe('-50px');
  fireEvent.pointerUp(compact, { button: 0, clientX: 92, clientY: 85, pointerType: 'touch' });
  expect(compact.style.getPropertyValue('--compact-swipe-x')).toBe('0px');

  await waitFor(() => expect(store.getSnapshot().currentItem?.id).toBe('track-2'));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(audioFactory).toHaveBeenCalledTimes(1);
});

test('resets compact-player drag feedback when the pointer gesture is cancelled', async () => {
  setMobileViewport(true);
  const { store } = await playerFixture();
  render(<PlayerBar store={store} />);
  const compact = screen.getByRole('region', { name: 'Now playing' });

  fireEvent.pointerDown(compact, { button: 0, clientX: 160, clientY: 80, pointerType: 'touch' });
  fireEvent.pointerMove(compact, { button: 0, clientX: 118, clientY: 82, pointerType: 'touch' });
  expect(compact.style.getPropertyValue('--compact-swipe-x')).toBe('-42px');

  fireEvent.pointerCancel(compact, { clientX: 118, clientY: 82, pointerType: 'touch' });

  expect(compact.style.getPropertyValue('--compact-swipe-x')).toBe('0px');
  expect(compact).not.toHaveAttribute('data-compact-dragging');
  expect(store.getSnapshot().currentItem?.id).toBe('track-1');
});

test('applies keyboard shortcuts outside editable fields and exposes accessible help', async () => {
  setMobileViewport(false);
  const user = userEvent.setup();
  const { store } = await playerFixture();
  render(
    <>
      <label htmlFor="test-search">Search</label>
      <input id="test-search" />
      <PlayerBar store={store} />
    </>
  );

  fireEvent.keyDown(document, { key: ' ' });
  await waitFor(() => expect(store.getSnapshot().status).toBe('playing'));
  fireEvent.keyDown(document, { key: 'ArrowRight' });
  expect(store.getSnapshot().currentTime).toBe(40);

  const input = screen.getByRole('textbox', { name: 'Search' });
  input.focus();
  fireEvent.keyDown(input, { key: ' ' });
  fireEvent.keyDown(input, { key: 'ArrowRight' });
  expect(store.getSnapshot()).toMatchObject({ status: 'playing', currentTime: 40 });

  await user.click(screen.getByRole('button', { name: 'Keyboard shortcuts' }));
  const help = screen.getByRole('dialog', { name: 'Keyboard shortcuts' });
  expect(document.querySelector('section[aria-label="Now playing"]')).toHaveAttribute('inert');
  expect(within(help).getByText('Shortcuts work anywhere except while typing in a field.')).toBeInTheDocument();
  expect(within(help).getByText('Play or pause')).toBeInTheDocument();

  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).not.toBeInTheDocument();
});

test('exposes five state-driven desktop transport controls', async () => {
  setMobileViewport(false);
  const user = userEvent.setup();
  const { store } = await playerFixture(1);
  render(<PlayerBar store={store} />);

  expect(screen.queryByRole('button', { name: /Open Now Playing/ })).not.toBeInTheDocument();
  const controls = screen.getByRole('group', { name: 'Playback controls' });
  expect(within(controls).getAllByRole('button')).toHaveLength(5);
  expect(within(controls).getByRole('button', { name: 'Previous soundtrack' })).toBeEnabled();
  expect(within(controls).getByRole('button', { name: 'Next soundtrack' })).toBeDisabled();
  const shuffle = within(controls).getByRole('button', { name: 'Shuffle off. Turn shuffle on' });
  expect(shuffle).toHaveAttribute('aria-pressed', 'false');
  await user.click(shuffle);
  expect(within(controls).getByRole('button', { name: 'Shuffle enabled. Turn shuffle off' }))
    .toHaveAttribute('aria-pressed', 'true');

  await user.click(within(controls).getByRole('button', { name: 'Repeat off. Turn on repeat all' }));
  await user.click(within(controls).getByRole('button', { name: 'Repeat all enabled. Turn on repeat one' }));
  expect(within(controls).getByRole('button', { name: 'Repeat one enabled. Turn repeat off' }))
    .toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('slider', { name: 'Playback position' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Keyboard shortcuts' })).toBeEnabled();
});
