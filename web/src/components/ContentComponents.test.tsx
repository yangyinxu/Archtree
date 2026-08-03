import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

import type { AlbumSummary, ArtistSummary, AudioTrackSummary } from '../api/contentSchemas';
import { Artwork } from './Artwork';
import { ContentCard } from './ContentCard';
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

test('Artwork exposes an accessible fallback after image failure', () => {
  render(<Artwork alt="Cover for First Light" kind="audioTrack" src="/missing-artwork" />);
  fireEvent.error(screen.getByRole('img', { name: 'Cover for First Light' }));

  expect(screen.getByRole('img', { name: 'Cover for First Light' })).toBeInTheDocument();
  expect(screen.queryByRole('img', { name: 'Cover for First Light' })?.tagName).toBe('SPAN');
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
  await user.click(screen.getByRole('button', { name: 'Play First Light by Finitude Ensemble' }));
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
