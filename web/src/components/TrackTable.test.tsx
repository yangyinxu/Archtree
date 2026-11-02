import { render, screen, within } from '@testing-library/react';
import { Link, MemoryRouter } from 'react-router';

import { TrackTable, type TrackTableRow } from './TrackTable';

const row = (title: string, patch: Partial<TrackTableRow> = {}): TrackTableRow => ({
  key: title,
  title,
  duration: '3:00',
  state: null,
  playLabel: `Play ${title}`,
  onActivate: () => undefined,
  ...patch
});

const show = (variant: 'album' | 'playlist', rows: TrackTableRow[]) => render(
  <MemoryRouter>
    <TrackTable
      albumHeading="Album"
      durationHeading="Duration"
      label="Quiet sequence MediaTracks"
      rows={rows}
      titleHeading="Title"
      variant={variant}
    />
  </MemoryRouter>
);

test('the column header is hidden from assistive technology and names its columns', () => {
  const { container, unmount } = show('album', [row('Night')]);
  const header = container.querySelector('[data-track-table-header]')!;
  expect(header).toHaveAttribute('aria-hidden', 'true');
  expect(header).toHaveTextContent('#Title');
  expect(header).not.toHaveTextContent('Album');
  unmount();

  const playlist = show('playlist', [row('Night')]);
  expect(playlist.container.querySelector('[data-track-table-header]')).toHaveTextContent('#TitleAlbum');
});

test('the playing row shows bars and Pause on its current button', async () => {
  show('album', [row('Night', { state: 'playing', playLabel: 'Pause' })]);
  const pause = screen.getByRole('button', { name: 'Pause' });
  expect(pause.closest('li')).toHaveAttribute('data-playback-state', 'playing');
  expect(pause).toHaveAttribute('aria-current', 'true');
  await expect.poll(() => pause.querySelector('.lucide-audio-lines')).toBeInTheDocument();
  await expect.poll(() => pause.querySelector('.lucide-pause')).toBeInTheDocument();
});

test('a paused current row keeps its indicator and offers Play', async () => {
  show('album', [row('Night', { state: 'paused' })]);
  const play = screen.getByRole('button', { name: 'Play Night' });
  expect(play.closest('li')).toHaveAttribute('data-playback-state', 'paused');
  expect(play).toHaveAttribute('aria-current', 'true');
  expect(play.querySelector('.lucide-audio-lines')).not.toBeInTheDocument();
  await expect.poll(() => play.querySelector('.lucide-play')).toBeInTheDocument();
  expect(screen.getByText('Night').className).toContain('trackTitlePlaying');
});

test('a disabled row renders no play glyph', async () => {
  show('playlist', [row('Gone', { disabled: true, playLabel: 'Gone cannot be played' }), row('Night')]);
  const disabled = screen.getByRole('button', { name: 'Gone cannot be played' });
  expect(disabled).toBeDisabled();
  expect(disabled.closest('li')).toHaveAttribute('data-unavailable', 'true');
  await expect.poll(() => screen.getByRole('button', { name: 'Play Night' }).querySelector('.lucide-play'))
    .toBeInTheDocument();
  expect(disabled.querySelector('svg')).not.toBeInTheDocument();
});

test('byline and Album links are siblings of the row button, never inside it', () => {
  show('playlist', [row('Night', {
    byline: <Link to="/artists/lead">Finite Ensemble</Link>,
    album: <Link to="/albums/night">Night Geometry</Link>
  })]);
  const list = screen.getByRole('list', { name: 'Quiet sequence MediaTracks' });
  const button = within(list).getByRole('button', { name: 'Play Night' });
  for (const link of within(list).getAllByRole('link')) expect(button).not.toContainElement(link);
  expect(within(list).getByRole('link', { name: 'Night Geometry' })).toHaveAttribute('href', '/albums/night');
});
