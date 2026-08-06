import { playbackActivityTarget } from './activityPolicy';

test('records an album only when its album play control launches playback', () => {
  expect(playbackActivityTarget({ type: 'albumPlay', albumId: 'album-1' })).toEqual({
    contentType: 'album',
    contentId: 'album-1'
  });
});

test.each([
  { type: 'explicitAlbumTrack' as const, trackId: 'track-in-album' },
  { type: 'playlistTrack' as const, trackId: 'track-in-playlist' },
  { type: 'standaloneTrack' as const, trackId: 'standalone-track' }
])('records an explicitly launched track for $type', (event) => {
  expect(playbackActivityTarget(event)).toEqual({
    contentType: 'audioTrack',
    contentId: event.trackId
  });
});

test.each([
  { type: 'previous' as const },
  { type: 'next' as const },
  { type: 'auto' as const },
  { type: 'restored' as const }
])('does not record queue-driven playback for $type', (event) => {
  expect(playbackActivityTarget(event)).toBeNull();
});
