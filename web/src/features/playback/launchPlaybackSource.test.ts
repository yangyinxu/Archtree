import { playerStore, type PlayerQueueItem, type PlayerSnapshot } from '../../player';
import type { AudioTrackSummary } from '../../api/contentSchemas';
import {
  launchAlbumPlayback,
  launchFromSource,
  launchPlaylistPlayback,
  launchStandalonePlayback,
  playbackSourcePath,
  resetPlaybackSource
} from './launchPlayback';

const item = (id: string): PlayerQueueItem => ({
  id, title: id, artworkUrl: '', artistNames: ['Aster Vale'], mediaType: 'video', streamUrl: `/stream/${id}`
});

let snapshot: PlayerSnapshot;

/** Mimics a player launch: the queue changes synchronously, before the returned promise settles. */
const launching = (queue: readonly PlayerQueueItem[]) => () => {
  snapshot = { ...snapshot, queue };
  return Promise.resolve();
};

beforeEach(() => {
  resetPlaybackSource();
  snapshot = playerStore.getSnapshot();
  vi.spyOn(playerStore, 'getSnapshot').mockImplementation(() => snapshot);
});

test('names the launching page only for the queue that launch created', async () => {
  const first = Object.freeze([item('a')]);
  await launchFromSource('/playlists/p1', launching(first));
  expect(playbackSourcePath(first)).toBe('/playlists/p1');

  const second = Object.freeze([item('a')]);
  await launchFromSource('/albums/album-1', launching(second));
  expect(playbackSourcePath(first)).toBeUndefined();
  expect(playbackSourcePath(second)).toBe('/albums/album-1');
});

test('a refused launch keeps the page of the queue that is still playing', async () => {
  const playing = Object.freeze([item('a')]);
  await launchFromSource('/playlists/p1', launching(playing));

  const refused = launchFromSource('/albums/album-1', () => Promise.reject(new Error('room playback')));
  await expect(refused).rejects.toThrow('room playback');
  expect(playbackSourcePath(playing)).toBe('/playlists/p1');
});

test('a launch without a page leaves the new queue without one', async () => {
  const playing = Object.freeze([item('a')]);
  await launchFromSource('/playlists/p1', launching(playing));

  const standalone = Object.freeze([item('b')]);
  await launchFromSource(null, launching(standalone));
  expect(playbackSourcePath(standalone)).toBeUndefined();
  expect(playbackSourcePath(playing)).toBeUndefined();
});

test.each(['album', 'playlist', 'single', 'unassigned'] as const)('a %s launch returns to its owning listener page', async (kind) => {
  const track: AudioTrackSummary = {
    ...item('a'), artistNames: ['Aster Vale'], contentType: 'audioTrack', albumId: kind === 'unassigned' ? null : 'album-1',
    albumTitle: null, duration: '3:00'
  };
  const queue = Object.freeze([item('a')]);
  vi.spyOn(playerStore, 'launchAlbumQueue').mockImplementation(launching(queue));
  vi.spyOn(playerStore, 'launchQueue').mockImplementation(launching(queue));
  vi.spyOn(playerStore, 'launchStandalone').mockImplementation(launching(queue));

  if (kind === 'album') await launchAlbumPlayback('album-1', [track]);
  else if (kind === 'playlist') await launchPlaylistPlayback('playlist-1', [track]);
  else await launchStandalonePlayback(track);

  expect(playbackSourcePath(queue)).toBe(kind === 'unassigned' ? undefined
    : kind === 'playlist' ? '/playlists/playlist-1' : '/albums/album-1');
});
