import { classifyApiOperation, classifyListenerRoute, statusBucket } from './routeClassifier';

test('reduces dynamic listener URLs to bounded route names', () => {
  expect(classifyListenerRoute('/finitude')).toBe('home');
  expect(classifyListenerRoute('/finitude/albums/private-content-id?from=search-term')).toBe('album');
  expect(classifyListenerRoute('/finitude/artists/private-content-id')).toBe('artist');
  expect(classifyListenerRoute('/finitude/playlists')).toBe('playlists');
  expect(classifyListenerRoute('/finitude/playlists/private-playlist-id')).toBe('playlist');
  expect(classifyListenerRoute('/finitude/reset-password/private-token')).toBe('auth');
  expect(classifyListenerRoute('/finitude/unrecognized/private-content-id')).toBe('other');
});

test('maps only allowlisted listener operations and excludes every auth endpoint', () => {
  expect(classifyApiOperation('/api/listener/v1/capabilities')).toBe('listener_capabilities');
  expect(classifyApiOperation('/api/listener/v1/search?q=private-term')).toBe('listener_search');
  expect(classifyApiOperation('/api/listener/v1/tracks/private-id')).toBe('listener_track');
  expect(classifyApiOperation('/content/me/saves/status', 'POST')).toBe('save_status');
  expect(classifyApiOperation('/content/me/saves/audioTrack/private-id', 'PUT')).toBe('save');
  expect(classifyApiOperation('/content/me/saves/audioTrack/private-id', 'DELETE')).toBe('unsave');
  expect(classifyApiOperation('/content/me/playlists', 'GET')).toBe('playlist_list');
  expect(classifyApiOperation('/content/me/playlists/memberships?audioTrackIds=private', 'GET'))
    .toBe('playlist_memberships');
  expect(classifyApiOperation('/content/me/playlists/private-id', 'PATCH')).toBe('playlist_rename');
  expect(classifyApiOperation('/content/me/playlists/private-id/items/private-item', 'DELETE')).toBe('playlist_remove');
  expect(classifyApiOperation('/auth/browser/session')).toBeNull();
  expect(classifyApiOperation('/auth/avatar', 'POST')).toBeNull();
  expect(classifyApiOperation('/content/unclassified/private-id')).toBeNull();
});

test('buckets only actionable HTTP statuses without retaining arbitrary codes', () => {
  expect(statusBucket()).toBe('none');
  expect(statusBucket(401)).toBe('401');
  expect(statusBucket(418)).toBe('other');
  expect(statusBucket(503)).toBe('5xx');
  expect(statusBucket(204)).toBe('other');
});
