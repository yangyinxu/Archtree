import { classifyApiOperation, classifyListenerRoute, statusBucket } from './routeClassifier';

test('reduces dynamic listener URLs to bounded route names', () => {
  expect(classifyListenerRoute('/listen')).toBe('home');
  expect(classifyListenerRoute('/listen/albums/private-content-id?from=search-term')).toBe('album');
  expect(classifyListenerRoute('/listen/artists/private-content-id')).toBe('artist');
  expect(classifyListenerRoute('/listen/reset-password/private-token')).toBe('auth');
  expect(classifyListenerRoute('/listen/unrecognized/private-content-id')).toBe('other');
});

test('maps only allowlisted listener operations and excludes every auth endpoint', () => {
  expect(classifyApiOperation('/api/listener/v1/search?q=private-term')).toBe('listener_search');
  expect(classifyApiOperation('/api/listener/v1/tracks/private-id')).toBe('listener_track');
  expect(classifyApiOperation('/content/me/saves/status', 'POST')).toBe('save_status');
  expect(classifyApiOperation('/content/me/saves/audioTrack/private-id', 'PUT')).toBe('save');
  expect(classifyApiOperation('/content/me/saves/audioTrack/private-id', 'DELETE')).toBe('unsave');
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
