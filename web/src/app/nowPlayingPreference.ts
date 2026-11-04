export const nowPlayingPreferenceStorageKey = 'finitude:now-playing-open:v1';

type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>;

const browserStorage = (): PreferenceStorage | null => {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
};

/** Restores explicit device-local panel intent; missing or invalid values keep the default open. */
export const readNowPlayingOpen = (storage: PreferenceStorage | null = browserStorage()): boolean => {
  try {
    return storage?.getItem(nowPlayingPreferenceStorageKey) !== 'false';
  } catch {
    return true;
  }
};

/** Saves only a listener's explicit choice, independently of panel widths and responsive visibility. */
export const writeNowPlayingOpen = (
  open: boolean,
  storage: PreferenceStorage | null = browserStorage()
): boolean => {
  if (!storage || typeof open !== 'boolean') return false;
  try {
    storage.setItem(nowPlayingPreferenceStorageKey, String(open));
    return true;
  } catch {
    return false;
  }
};
