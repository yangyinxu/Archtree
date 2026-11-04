import type { PlayerRepeatMode } from './types';

/** Device-local choices only; playback content and account state never enter storage. */
export interface PlayerPreferences {
  volume: number;
  muted: boolean;
  shuffleEnabled: boolean;
  repeatMode: PlayerRepeatMode;
}

/** Injectable storage keeps isolated player instances independent of the browser singleton. */
export interface PlayerPreferencesPersistence {
  read(): PlayerPreferences;
  write(changes: Partial<PlayerPreferences>): void;
}

export const playerPreferencesStorageKey = 'finitude:player-preferences:v1';
export const defaultPlayerPreferences: Readonly<PlayerPreferences> = Object.freeze({
  volume: 1, muted: false, shuffleEnabled: false, repeatMode: 'off'
});

type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** Storage can be denied even when the browser exposes a localStorage property. */
const browserStorage = (): PreferenceStorage | null => {
  try { return typeof window === 'undefined' ? null : window.localStorage; }
  catch { return null; }
};

/** Restores valid choices independently so one damaged field cannot erase the others. */
export const createPlayerPreferencesPersistence = (
  storage: PreferenceStorage | null = browserStorage()
): PlayerPreferencesPersistence => {
  const read = (): PlayerPreferences => {
    const defaults = { ...defaultPlayerPreferences };
    try {
      const raw = storage?.getItem(playerPreferencesStorageKey);
      if (!raw || raw.length > 2048) return defaults;
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return defaults;
      const record = parsed as Record<string, unknown>;
      if (record.version !== 1) return defaults;
      return {
        volume: typeof record.volume === 'number'
          && record.volume >= 0 && record.volume <= 1 ? record.volume : defaults.volume,
        muted: record.muted === true,
        shuffleEnabled: record.shuffleEnabled === true,
        repeatMode: record.repeatMode === 'all' || record.repeatMode === 'one'
          ? record.repeatMode : defaults.repeatMode
      };
    } catch { return defaults; }
  };
  return {
    read,
    write: changes => {
      // Another document may have changed a different setting since this player loaded.
      const { volume, muted, shuffleEnabled, repeatMode } = { ...read(), ...changes };
      try {
        storage?.setItem(playerPreferencesStorageKey, JSON.stringify({
          version: 1, volume, muted, shuffleEnabled, repeatMode
        }));
      } catch { /* A denied or full store must not disable live player controls. */ }
    }
  };
};
