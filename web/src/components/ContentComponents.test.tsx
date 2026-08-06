import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

import type { AlbumSummary, ArtistSummary, AudioTrackSummary } from '../api/contentSchemas';
import { Artwork } from './Artwork';
import { ContentCard, defaultContentCardArtworkSizes } from './ContentCard';
import { PageSection } from './PageSection';

const artist: ArtistSummary = {
  contentType: 'artist',
  id: 'artist-1',
  name: 'Finitude Ensemble',
  bio: '',
  artworkUrl: ''
};

const album: AlbumSummary = {
  contentType: 'album',
  id: 'album-1',
  title: 'Still Water',
  artworkUrl: '',
  artistNames: ['Finitude Ensemble'],
  releaseDate: { year: 2026 }
};

const audioTrack: AudioTrackSummary = {
  contentType: 'audioTrack',
  id: 'track-1',
  title: 'First Light',
  artworkUrl: '/missing-artwork',
  artistNames: ['Finitude Ensemble'],
  albumId: 'album-1',
  albumTitle: 'Still Water',
  duration: '3:48',
  streamUrl: '/content/audioTrack/stream/track-1'
};

interface CarouselGeometryOptions {
  cardGap?: number;
  cardWidth?: number;
  clientWidth?: number;
  scrollLeft?: number;
  scrollWidth?: number;
}

/** Supplies the layout geometry that JSDOM does not calculate for overflow collections. */
const configureCarouselGeometry = (
  carousel: HTMLUListElement,
  {
    cardGap = 20,
    cardWidth = 100,
    clientWidth = 240,
    scrollLeft = 0,
    scrollWidth = 540
  }: CarouselGeometryOptions = {}
) => {
  let currentClientWidth = clientWidth;
  let currentScrollLeft = scrollLeft;
  let currentScrollWidth = scrollWidth;
  Object.defineProperties(carousel, {
    clientWidth: {
      configurable: true,
      get: () => currentClientWidth
    },
    scrollLeft: {
      configurable: true,
      get: () => currentScrollLeft,
      set: (value: number) => { currentScrollLeft = value; }
    },
    scrollWidth: {
      configurable: true,
      get: () => currentScrollWidth
    }
  });
  Array.from(carousel.children).forEach((child, index) => {
    Object.defineProperties(child, {
      offsetLeft: { configurable: true, value: index * (cardWidth + cardGap) },
      offsetWidth: { configurable: true, value: cardWidth }
    });
  });
  const scrollTo = vi.fn((options: ScrollToOptions) => {
    if (typeof options.left === 'number') currentScrollLeft = options.left;
  });
  Object.defineProperty(carousel, 'scrollTo', {
    configurable: true,
    value: scrollTo
  });

  return {
    scrollTo,
    setClientWidth: (value: number) => { currentClientWidth = value; },
    setScrollLeft: (value: number) => { currentScrollLeft = value; },
    setScrollWidth: (value: number) => { currentScrollWidth = value; }
  };
};

const requestCarouselRemeasure = () => {
  act(() => window.dispatchEvent(new Event('resize')));
};

test('Artwork exposes an accessible fallback after image failure', () => {
  render(<Artwork alt="Cover for First Light" kind="audioTrack" src="/missing-artwork" />);
  fireEvent.error(screen.getByRole('img', { name: 'Cover for First Light' }));

  expect(screen.getByRole('img', { name: 'Cover for First Light' })).toBeInTheDocument();
  expect(screen.queryByRole('img', { name: 'Cover for First Light' })?.tagName).toBe('SPAN');
});

test('Artwork keeps the managed original while exposing responsive candidates and priority hints', () => {
  const source = '/content/images/0123456789abcdef01234567';
  render(
    <Artwork
      alt="Cover for First Light"
      fetchPriority="high"
      kind="audioTrack"
      loading="eager"
      sizes="20rem"
      src={source}
    />
  );

  const image = screen.getByRole('img', { name: 'Cover for First Light' });
  expect(image).toHaveAttribute('src', source);
  expect(image).toHaveAttribute('sizes', '20rem');
  expect(image).toHaveAttribute('loading', 'eager');
  expect(image).toHaveAttribute('fetchpriority', 'high');
  expect(image.getAttribute('srcset')).toContain(`${source}/v1/96.webp 96w`);
  expect(image.getAttribute('srcset')).toContain(`${source}/v1/1280.webp 1280w`);
});

test('Artwork retries the managed original before showing a fallback', () => {
  const source = '/content/images/0123456789abcdef01234567';
  render(<Artwork alt="Managed cover" kind="album" sizes="20rem" src={source} />);

  fireEvent.error(screen.getByRole('img', { name: 'Managed cover' }));
  const originalRetry = screen.getByRole('img', { name: 'Managed cover' });
  expect(originalRetry).toHaveAttribute('src', source);
  expect(originalRetry).not.toHaveAttribute('srcset');
  expect(originalRetry).not.toHaveAttribute('sizes');

  fireEvent.error(originalRetry);
  expect(screen.getByRole('img', { name: 'Managed cover' }).tagName).toBe('SPAN');
});

test('Artwork leaves non-managed sources unchanged without a derived srcset', () => {
  const source = 'https://images.example.com/cover.webp';
  render(<Artwork alt="External cover" kind="album" sizes="20rem" src={source} />);

  const image = screen.getByRole('img', { name: 'External cover' });
  expect(image).toHaveAttribute('src', source);
  expect(image).not.toHaveAttribute('srcset');
  expect(image).not.toHaveAttribute('sizes');
});

test('standalone cards describe the narrow single-column search layout', () => {
  const managedArtist = {
    ...artist,
    artworkUrl: '/content/images/0123456789abcdef01234567'
  };
  const { container } = render(
    <MemoryRouter>
      <ContentCard item={managedArtist} />
    </MemoryRouter>
  );

  expect(container.querySelector('img')).toHaveAttribute('sizes', defaultContentCardArtworkSizes);
  expect(defaultContentCardArtworkSizes).toContain('(max-width: 400px) calc(100vw - 3.3rem - 2px)');
});

test('cards link artist and album details while tracks dispatch onPlay', async () => {
  const user = userEvent.setup();
  const onPlay = vi.fn();
  render(
    <MemoryRouter>
      <ContentCard item={artist} />
      <ContentCard item={album} />
      <ContentCard item={audioTrack} onPlay={onPlay} />
    </MemoryRouter>
  );

  expect(screen.getByRole('link', { name: 'Finitude Ensemble, artist' })).toHaveAttribute('href', '/artists/artist-1');
  expect(screen.getByRole('link', { name: 'Still Water, album' })).toHaveAttribute('href', '/albums/album-1');
  const playButton = screen.getByRole('button', { name: 'Play First Light by Finitude Ensemble' });
  expect(playButton.querySelector('.lucide-play')).toBeInTheDocument();
  expect(playButton.querySelector('button')).toBeNull();
  await user.click(playButton);
  expect(onPlay).toHaveBeenCalledWith(audioTrack);
});

test.each(['carousel', 'grid', 'list'] as const)('preserves the %s presentation with list semantics', (presentation) => {
  const onPlay = vi.fn();
  const { container } = render(
    <MemoryRouter>
      <PageSection
        id={`${presentation}-section`}
        items={[album, audioTrack]}
        onPlay={onPlay}
        presentation={presentation}
        title={`${presentation} music`}
      />
    </MemoryRouter>
  );

  const collection = container.querySelector(`[data-presentation="${presentation}"]`);
  expect(collection).toBeInTheDocument();
  expect(collection?.tagName).toBe('UL');
  expect(collection?.children).toHaveLength(2);
  if (presentation === 'carousel') {
    expect(collection).toHaveAttribute('tabindex', '0');
    expect(collection).toHaveAccessibleName('carousel music carousel');
  }
});

test('shows only the available carousel directions as overflow moves between edges', async () => {
  const { container } = render(
    <MemoryRouter>
      <PageSection
        id="overflow-directions"
        items={[album, audioTrack]}
        presentation="carousel"
        title="Overflow picks"
      />
    </MemoryRouter>
  );
  const carousel = container.querySelector('[data-presentation="carousel"]') as HTMLUListElement;
  const geometry = configureCarouselGeometry(carousel);

  requestCarouselRemeasure();
  const next = screen.getByRole('button', { name: 'Show next items in Overflow picks' });
  expect(screen.queryByRole('button', { name: 'Show previous items in Overflow picks' })).not.toBeInTheDocument();
  expect(next).toHaveAttribute('aria-controls', 'listener-section-overflow-directions-carousel');
  expect(screen.getByRole('group', { name: 'Overflow picks carousel controls' })).toBeInTheDocument();

  geometry.setScrollLeft(120);
  fireEvent.scroll(carousel);
  expect(screen.getByRole('button', { name: 'Show previous items in Overflow picks' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Show next items in Overflow picks' })).toBeInTheDocument();

  screen.getByRole('button', { name: 'Show next items in Overflow picks' }).focus();
  geometry.setScrollLeft(300);
  fireEvent.scroll(carousel);
  expect(screen.queryByRole('button', { name: 'Show next items in Overflow picks' })).not.toBeInTheDocument();
  await waitFor(() => {
    expect(screen.getByRole('button', { name: 'Show previous items in Overflow picks' })).toHaveFocus();
  });

  geometry.setScrollLeft(0.5);
  fireEvent.scroll(carousel);
  expect(screen.queryByRole('button', { name: 'Show previous items in Overflow picks' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Show next items in Overflow picks' })).toBeInTheDocument();
});

test('uses stable page and boundary commands without intercepting keys from cards', () => {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }));
  const { container } = render(
    <MemoryRouter>
      <PageSection
        id="keyboard-carousel"
        items={[album, audioTrack]}
        presentation="carousel"
        title="Keyboard picks"
      />
    </MemoryRouter>
  );
  const carousel = container.querySelector('[data-presentation="carousel"]') as HTMLUListElement;
  const geometry = configureCarouselGeometry(carousel);
  requestCarouselRemeasure();

  fireEvent.click(screen.getByRole('button', { name: 'Show next items in Keyboard picks' }));
  expect(geometry.scrollTo).toHaveBeenLastCalledWith({ behavior: 'smooth', left: 120 });

  carousel.focus();
  fireEvent.keyDown(carousel, { key: 'End' });
  expect(geometry.scrollTo).toHaveBeenLastCalledWith({ behavior: 'smooth', left: 300 });
  fireEvent.keyDown(carousel, { key: 'Home' });
  expect(geometry.scrollTo).toHaveBeenLastCalledWith({ behavior: 'smooth', left: 0 });
  fireEvent.keyDown(carousel, { key: 'PageDown' });
  expect(geometry.scrollTo).toHaveBeenLastCalledWith({ behavior: 'smooth', left: 120 });
  fireEvent.keyDown(carousel, { key: 'PageUp' });
  expect(geometry.scrollTo).toHaveBeenLastCalledWith({ behavior: 'smooth', left: 0 });

  const callCount = geometry.scrollTo.mock.calls.length;
  fireEvent.keyDown(screen.getByRole('link', { name: 'Still Water, album' }), { key: 'PageDown' });
  fireEvent.keyDown(carousel, { key: 'ArrowRight' });
  expect(geometry.scrollTo).toHaveBeenCalledTimes(callCount);
});

test('uses immediate carousel scrolling when reduced motion is requested', () => {
  vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
    matches: query === '(prefers-reduced-motion: reduce)'
  })));
  const { container } = render(
    <MemoryRouter>
      <PageSection
        id="reduced-motion-carousel"
        items={[album, audioTrack]}
        presentation="carousel"
        title="Quiet movement"
      />
    </MemoryRouter>
  );
  const carousel = container.querySelector('[data-presentation="carousel"]') as HTMLUListElement;
  const geometry = configureCarouselGeometry(carousel);
  requestCarouselRemeasure();

  fireEvent.click(screen.getByRole('button', { name: 'Show next items in Quiet movement' }));
  expect(geometry.scrollTo).toHaveBeenCalledWith({ behavior: 'auto', left: 120 });
});

test('recalculates carousel overflow with ResizeObserver and item-count changes', () => {
  let resizeCallback: ResizeObserverCallback | undefined;
  const observe = vi.fn();
  const disconnect = vi.fn();
  class CarouselResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      resizeCallback = callback;
    }

    disconnect = disconnect;
    observe = observe;
  }
  vi.stubGlobal('ResizeObserver', CarouselResizeObserver);

  const { container, rerender, unmount } = render(
    <MemoryRouter>
      <PageSection
        id="resizing-carousel"
        items={[album, audioTrack]}
        presentation="carousel"
        title="Resizing picks"
      />
    </MemoryRouter>
  );
  const carousel = container.querySelector('[data-presentation="carousel"]') as HTMLUListElement;
  const geometry = configureCarouselGeometry(carousel);

  act(() => resizeCallback?.([], {} as ResizeObserver));
  expect(observe).toHaveBeenCalledWith(carousel);
  expect(screen.getByRole('button', { name: 'Show next items in Resizing picks' })).toBeInTheDocument();

  geometry.setScrollWidth(240);
  rerender(
    <MemoryRouter>
      <PageSection
        id="resizing-carousel"
        items={[album]}
        presentation="carousel"
        title="Resizing picks"
      />
    </MemoryRouter>
  );
  expect(screen.queryByRole('group', { name: 'Resizing picks carousel controls' })).not.toBeInTheDocument();

  unmount();
  expect(disconnect).toHaveBeenCalled();
});

test('section presentations describe the rendered card and list artwork widths', () => {
  const managedAlbum = {
    ...album,
    artworkUrl: '/content/images/0123456789abcdef01234567'
  };
  const { container, rerender } = render(
    <MemoryRouter>
      <PageSection
        id="responsive-carousel"
        items={[managedAlbum]}
        presentation="carousel"
        title="Responsive carousel"
      />
    </MemoryRouter>
  );

  expect(container.querySelector('img')).toHaveAttribute(
    'sizes',
    '(max-width: 480px) calc(min(72vw, 17.5rem) - 1.3rem - 2px), calc(clamp(10.5rem, 16vw, 13rem) - 1.3rem - 2px)'
  );

  rerender(
    <MemoryRouter>
      <PageSection
        id="responsive-grid"
        items={[managedAlbum]}
        presentation="grid"
        title="Responsive grid"
      />
    </MemoryRouter>
  );
  expect(container.querySelector('img')).toHaveAttribute(
    'sizes',
    '(max-width: 340px) calc(100vw - 3.3rem - 2px), (max-width: 480px) calc((100vw - 2.75rem) / 2 - 1.3rem - 2px), (max-width: 1023px) calc(10.5rem - 1.3rem - 2px), calc(14rem - 1.3rem - 2px)'
  );

  rerender(
    <MemoryRouter>
      <PageSection
        id="responsive-list"
        items={[managedAlbum]}
        presentation="list"
        title="Responsive list"
      />
    </MemoryRouter>
  );
  expect(container.querySelector('img')).toHaveAttribute('sizes', '3.15rem');
});
