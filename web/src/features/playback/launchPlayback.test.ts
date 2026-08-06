import { waitFor } from '@testing-library/react';

import type { AudioTrackSummary } from '../../api/contentSchemas';
import { playerStore } from '../../player';
import { launchPlaylistPlayback } from './launchPlayback';

const tracks: AudioTrackSummary[] = [
  {
    contentType: 'audioTrack',
    id: 'track-1',
    title: 'Night',
    artworkUrl: '',
    artistNames: ['Finite Ensemble'],
    albumId: null,
    albumTitle: null,
    duration: '3:00',
    streamUrl: '/content/audioTrack/stream/track-1'
  },
  {
    contentType: 'audioTrack',
    id: 'track-2',
    title: 'Dawn',
    artworkUrl: '',
    artistNames: ['Finite Ensemble'],
    albumId: null,
    albumTitle: null,
    duration: '4:00',
    streamUrl: '/content/audioTrack/stream/track-2'
  }
];

test('Playlist launch snapshots the ready queue and records only the explicit start track', async () => {
  const idleSnapshot = playerStore.getSnapshot();
  const launch = vi.spyOn(playerStore, 'launchQueue').mockResolvedValue();
  vi.spyOn(playerStore, 'getSnapshot').mockReturnValue({
    ...idleSnapshot,
    status: 'playing',
    currentItem: {
      id: 'track-2',
      title: 'Dawn',
      artworkUrl: '',
      artistNames: ['Finite Ensemble'],
      streamUrl: '/content/audioTrack/stream/track-2'
    }
  });
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const target = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ ...target, recorded: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  });
  vi.stubGlobal('fetch', fetchMock);

  await launchPlaylistPlayback(tracks, 'viewer-1', 'track-2');

  expect(launch).toHaveBeenCalledWith([
    expect.objectContaining({ id: 'track-1' }),
    expect.objectContaining({ id: 'track-2' })
  ], 1);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  expect(fetchMock).toHaveBeenCalledWith(
    '/content/me/recently-played',
    expect.objectContaining({
      body: JSON.stringify({ contentType: 'audioTrack', contentId: 'track-2' }),
      method: 'POST'
    })
  );
  expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('X-Finitude-Account-Viewer')).toBe('viewer-1');
});

test('a superseded Playlist launch cannot borrow the newer queue state for activity', async () => {
  const idleSnapshot = playerStore.getSnapshot();
  let finishFirstLaunch: (() => void) | undefined;
  vi.spyOn(playerStore, 'launchQueue')
    .mockImplementationOnce(() => new Promise<void>((resolve) => {
      finishFirstLaunch = resolve;
    }))
    .mockResolvedValueOnce();
  vi.spyOn(playerStore, 'getSnapshot').mockReturnValue({
    ...idleSnapshot,
    status: 'playing',
    currentItem: {
      id: 'track-2',
      title: 'Dawn',
      artworkUrl: '',
      artistNames: ['Finite Ensemble'],
      streamUrl: '/content/audioTrack/stream/track-2'
    }
  });
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const target = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ ...target, recorded: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  });
  vi.stubGlobal('fetch', fetchMock);

  const first = launchPlaylistPlayback([tracks[0]], 'viewer-1');
  await launchPlaylistPlayback([tracks[1]], 'viewer-1');
  finishFirstLaunch?.();
  await first;

  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  expect(fetchMock).toHaveBeenCalledWith(
    '/content/me/recently-played',
    expect.objectContaining({
      body: JSON.stringify({ contentType: 'audioTrack', contentId: 'track-2' })
    })
  );
});
