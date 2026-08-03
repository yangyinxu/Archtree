const searchHistoryPrefix = 'finitude:search-history:';
const maximumSearchHistoryEntries = 10;

const storageKey = (accountId: string | null | undefined) =>
  `${searchHistoryPrefix}${accountId?.trim() || 'anonymous'}`;

const browserStorage = () => {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
};

/** Reads bounded device-local search history without trusting stored JSON. */
export const readSearchHistory = (accountId?: string | null) => {
  const storage = browserStorage();
  if (!storage) return [];
  try {
    const parsed = JSON.parse(storage.getItem(storageKey(accountId)) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter(Boolean)
      .slice(0, maximumSearchHistoryEntries);
  } catch {
    return [];
  }
};

/** Moves a repeated query to newest while keeping account histories isolated. */
export const rememberSearchQuery = (accountId: string | null | undefined, query: string) => {
  const normalized = query.trim();
  if (!normalized) return readSearchHistory(accountId);
  const history = readSearchHistory(accountId).filter(
    (value) => value.localeCompare(normalized, undefined, { sensitivity: 'accent' }) !== 0
  );
  const next = [normalized, ...history].slice(0, maximumSearchHistoryEntries);
  try {
    browserStorage()?.setItem(storageKey(accountId), JSON.stringify(next));
  } catch {
    // Private browsing and storage quotas must not block a public search.
  }
  return next;
};

/** Removes only the signed-out or authenticated identity supplied by the caller. */
export const clearSearchHistory = (accountId?: string | null) => {
  try {
    browserStorage()?.removeItem(storageKey(accountId));
  } catch {
    // Logout still succeeds when browser storage is unavailable.
  }
};
