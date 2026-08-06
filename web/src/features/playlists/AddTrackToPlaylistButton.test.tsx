import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

import type { AudioTrackSummary } from '../../api/contentSchemas';
import { listenerCapabilitiesQueryKey } from '../../api/listenerCapabilities';
import { AddTrackToPlaylistButton } from './AddTrackToPlaylistButton';

const track: AudioTrackSummary = {
  contentType: 'audioTrack',
  id: 'track-1',
  title: 'Blue Interval',
  artworkUrl: '',
  artistNames: ['Finite Ensemble'],
  albumId: null,
  albumTitle: null,
  duration: '3:24',
  streamUrl: '/content/audioTrack/stream/track-1'
};

const existingTrack: AudioTrackSummary = {
  ...track,
  id: 'track-existing',
  title: 'Existing soundtrack',
  artworkUrl: '/playlist-cover.jpg',
  streamUrl: '/content/audioTrack/stream/track-existing'
};

const summary = {
  id: 'playlist-1',
  name: 'Quiet sequence',
  itemCount: 1,
  artworkUrl: '/playlist-cover.jpg',
  revision: 1,
  createdAt: '2026-08-04T12:00:00.000Z',
  updatedAt: '2026-08-04T12:00:00.000Z'
};

const detail = {
  ...summary,
  itemCount: 2,
  revision: 2,
  updatedAt: '2026-08-04T12:05:00.000Z',
  items: [
    {
      itemId: 'item-existing',
      audioTrackId: existingTrack.id,
      addedAt: '2026-08-04T12:00:00.000Z',
      availability: 'ready',
      audioTrack: existingTrack
    },
    {
      itemId: 'item-1',
      audioTrackId: track.id,
      addedAt: '2026-08-04T12:05:00.000Z',
      availability: 'ready',
      audioTrack: track
    }
  ]
};

const jsonResponse = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200,
  headers: {
    'Content-Type': 'application/json',
    'X-Finitude-Account-Viewer': 'viewer-1'
  }
});

test('adds through the shared picker with viewer, revision, and idempotency guards', async () => {
  const user = userEvent.setup();
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') return jsonResponse(detail);
    if (String(input).startsWith('/content/me/playlists/memberships?')) {
      return jsonResponse({ items: [{ audioTrackId: track.id, playlistIds: [] }] });
    }
    return jsonResponse({ items: [summary], nextCursor: null });
  });
  vi.stubGlobal('fetch', fetchMock);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(listenerCapabilitiesQueryKey, { playlists: true });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AddTrackToPlaylistButton track={track} viewerId="viewer-1" />
      </MemoryRouter>
    </QueryClientProvider>
  );

  const trigger = screen.getByRole('button', { name: 'Add Blue Interval to Playlist' });
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await user.click(trigger);
  expect(trigger).toHaveAttribute('aria-expanded', 'true');
  const dialog = await screen.findByRole('dialog', { name: 'Choose a Playlist' });
  await within(dialog).findByText(summary.name);
  expect(dialog.querySelector('img')).toHaveAttribute('src', summary.artworkUrl);
  await user.click(await within(dialog).findByRole('button', { name: 'Add Blue Interval to Quiet sequence' }));

  expect(await within(dialog).findByRole('button', {
    name: 'Blue Interval is already in Quiet sequence'
  })).toBeDisabled();
  const postCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
  expect(postCall?.[0]).toBe('/content/me/playlists/playlist-1/items');
  expect(JSON.parse(String(postCall?.[1]?.body))).toEqual({ audioTrackId: 'track-1' });
  const headers = new Headers(postCall?.[1]?.headers);
  expect(headers.get('If-Match')).toBe('"1"');
  expect(headers.get('Idempotency-Key')).toBeTruthy();
  expect(headers.get('X-Finitude-Account-Viewer')).toBe('viewer-1');

  await user.click(within(dialog).getByRole('button', { name: 'Done' }));
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  expect(trigger).toHaveFocus();
});

test('marks an existing server membership before permitting another Add', async () => {
  const user = userEvent.setup();
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => (
    String(input).startsWith('/content/me/playlists/memberships?')
      ? jsonResponse({ items: [{ audioTrackId: track.id, playlistIds: [summary.id] }] })
      : jsonResponse({ items: [summary], nextCursor: null })
  ));
  vi.stubGlobal('fetch', fetchMock);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(listenerCapabilitiesQueryKey, { playlists: true });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AddTrackToPlaylistButton track={track} viewerId="viewer-1" />
      </MemoryRouter>
    </QueryClientProvider>
  );

  await user.click(screen.getByRole('button', { name: 'Add Blue Interval to Playlist' }));
  const dialog = await screen.findByRole('dialog', { name: 'Choose a Playlist' });
  expect(await within(dialog).findByRole('button', {
    name: 'Blue Interval is already in Quiet sequence'
  })).toBeDisabled();
  expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});
