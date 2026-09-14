import { safeLoginDestination } from './LoginPage';

test.each(['/social', '/social/invitations', '/social/invitations/i_abc-123', '/finitude/social/invitations/i_abc-123'])('preserves the narrow internal social continuation %s across login reloads', candidate => {
  expect(safeLoginDestination(undefined, `?returnTo=${encodeURIComponent(candidate)}`)).toBe(candidate.replace(/^\/finitude/, ''));
});

test.each(['https://evil.example', '//evil.example', '/\\evil.example', '/social/invitations/../account',
  '/social/invitations/%2F%2Fevil.example', '/social/invitations/id?next=https://evil.example',
  '/social/invitations/id#fragment', '/social/invitations/id\n', '/social/invitations/abc/extra',
  `/social/invitations/${'a'.repeat(81)}`, '/finitude//evil.example', '/social/unknown'])('rejects unsafe or unrecognized invitation continuation %s', candidate => {
  expect(safeLoginDestination(undefined, `?returnTo=${encodeURIComponent(candidate)}`)).toBe('/');
});

test('existing account, catalog and manager destinations keep their allowlisted behavior', () => {
  for (const path of ['/account', '/account/sessions', '/search?q=quiet', '/playlists/playlist-1', '/albums/album-1', '/content/manage/items']) {
    expect(safeLoginDestination({ from: path }, '')).toBe(path);
  }
  expect(safeLoginDestination({ from: '/account' }, '?returnTo=%2Fsocial%2Finvitations')).toBe('/account');
  expect(safeLoginDestination({ from: '//evil.example' }, '?returnTo=%2Fsocial%2Finvitations')).toBe('/');
});
