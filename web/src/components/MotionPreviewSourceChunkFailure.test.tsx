import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

import type { AudioTrackSummary } from '../api/contentSchemas';
import { listenerCapabilitiesWrapper } from '../test/listenerCapabilities';
import { ContentCard } from './ContentCard';

vi.mock('./MotionPreviewSource', () => { throw new TypeError('Failed to fetch dynamically imported module'); });

const videoTrack: AudioTrackSummary = {
  contentType: 'audioTrack',
  id: 'video-1',
  title: 'Moving Light',
  artworkUrl: '',
  artistNames: ['Finitude Ensemble'],
  albumId: 'album-1',
  albumTitle: 'Still Water',
  duration: '3:48',
  mediaType: 'video',
  streamUrl: '/content/mediaTrack/stream/video-1'
};

/** JSDOM has no PointerEvent, so pointerType would never reach the card's native listeners. */
class TestPointerEvent extends MouseEvent {
  readonly pointerType: string;

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerType = init.pointerType ?? '';
  }
}

/** Hovers the card past its intent delay on a device that allows previews. */
const hoverPastIntent = async () => {
  vi.stubGlobal('PointerEvent', TestPointerEvent);
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
    matches: query === '(hover: hover) and (pointer: fine)',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  })));
  vi.stubGlobal('fetch', vi.fn());
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  render(
    <MemoryRouter><ContentCard item={videoTrack} onPlay={vi.fn()} /></MemoryRouter>,
    { wrapper: listenerCapabilitiesWrapper() }
  );
  const card = screen.getByRole('button', { name: /Play Moving Light/ }).closest('article')!;
  fireEvent.pointerEnter(card, { pointerType: 'mouse' });
  await act(() => new Promise((resolve) => setTimeout(resolve, 700)));
  return { card, errors };
};

beforeAll(async () => {
  // The real preview chunk must already be loaded so the hover reaches the failing nested import.
  await import('./CardVideoPreview');
});

test('a presentation-flag chunk that cannot load shows no preview instead of failing the page', async () => {
  const { card, errors } = await hoverPastIntent();

  expect(screen.getByRole('button', { name: /Play Moving Light/ })).toBe(card.querySelector('button'));
  expect(card.querySelector('video')).toBeNull();
  expect(errors).not.toHaveBeenCalled();
});
