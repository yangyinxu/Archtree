import {
  clearSearchHistory,
  readSearchHistory,
  rememberSearchQuery
} from './searchHistory';

beforeEach(() => window.localStorage.clear());

test('keeps at most ten newest queries with case-insensitive deduplication', () => {
  for (let index = 0; index < 11; index += 1) {
    rememberSearchQuery('listener-1', `Query ${index}`);
  }
  rememberSearchQuery('listener-1', 'query 5');

  const history = readSearchHistory('listener-1');
  expect(history).toHaveLength(10);
  expect(history[0]).toBe('query 5');
  expect(history.filter((value) => value.toLowerCase() === 'query 5')).toHaveLength(1);
  expect(history).not.toContain('Query 0');
});

test('isolates identities and clears only the account that logs out', () => {
  rememberSearchQuery(null, 'Anonymous');
  rememberSearchQuery('listener-1', 'Private one');
  rememberSearchQuery('listener-2', 'Private two');

  clearSearchHistory('listener-1');

  expect(readSearchHistory('listener-1')).toEqual([]);
  expect(readSearchHistory('listener-2')).toEqual(['Private two']);
  expect(readSearchHistory(null)).toEqual(['Anonymous']);
});

test('ignores malformed stored values', () => {
  window.localStorage.setItem('finitude:search-history:listener-1', '{not-json');
  expect(readSearchHistory('listener-1')).toEqual([]);
});
