import {
  nowPlayingPreferenceStorageKey,
  readNowPlayingOpen,
  writeNowPlayingOpen
} from './nowPlayingPreference';
import { shellLayoutStorageKey } from './shellLayoutPreferences';

beforeEach(() => window.localStorage.clear());
afterEach(() => window.localStorage.clear());

test('restores explicit open and closed choices without modifying saved panel widths', () => {
  const widths = JSON.stringify({ version: 1, sidebarWidth: 350, nowPlayingWidth: 360 });
  window.localStorage.setItem(shellLayoutStorageKey, widths);
  expect(readNowPlayingOpen()).toBe(true);
  expect(writeNowPlayingOpen(false)).toBe(true);
  expect(readNowPlayingOpen()).toBe(false);
  expect(writeNowPlayingOpen(true)).toBe(true);
  expect(readNowPlayingOpen()).toBe(true);
  expect(window.localStorage.getItem(shellLayoutStorageKey)).toBe(widths);
});

test.each(['', '0', 'null', 'undefined', 'FALSE', '{}', '{"open":false}'])(
  'ignores malformed panel preference %s', (value) => {
    window.localStorage.setItem(nowPlayingPreferenceStorageKey, value);
    expect(readNowPlayingOpen()).toBe(true);
    expect(window.localStorage.getItem(nowPlayingPreferenceStorageKey)).toBe(value);
  }
);

test('tolerates storage denial and missing browser storage', () => {
  const blocked = {
    getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('blocked'); }
  };
  expect(readNowPlayingOpen(blocked)).toBe(true);
  expect(writeNowPlayingOpen(false, blocked)).toBe(false);
  expect(readNowPlayingOpen(null)).toBe(true);
  expect(writeNowPlayingOpen(false, null)).toBe(false);
});

test('tolerates an inaccessible browser storage property', () => {
  const unavailable = vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
    throw new Error('blocked');
  });
  try {
    expect(readNowPlayingOpen()).toBe(true);
    expect(writeNowPlayingOpen(false)).toBe(false);
  } finally {
    unavailable.mockRestore();
  }
});
