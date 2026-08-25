import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react';

import {
  embeddedManifest,
  getEmbeddedFallback,
  type LocalePreference,
  type LocalizationBundle,
  type LocalizationManifestLocale,
  type MessageKey,
  type MessageVariables
} from './contract';
import { directionForLocale, resolveLocalePreference } from './localeMatching';
import {
  localizationPreferenceStorageKey,
  readCachedBundle,
  readCachedManifest,
  readLocalePreference,
  writeLocalePreference
} from './storage';

type MessageFormatterConstructor = typeof import('intl-messageformat')['default'];
interface CachedMessageFormatter {
  format: (variables?: MessageVariables) => unknown;
}
const formatterCache = new Map<string, CachedMessageFormatter>();
let MessageFormatter: MessageFormatterConstructor | undefined;

/** Installs the ICU formatter chunk before the localized application renders. */
export const installMessageFormatter = (formatter: MessageFormatterConstructor) => {
  MessageFormatter = formatter;
};

const browserPreferredLocales = () => {
  if (typeof navigator === 'undefined') return [embeddedManifest.defaultLocale];
  return navigator.languages?.length
    ? [...navigator.languages]
    : navigator.language ? [navigator.language] : [embeddedManifest.defaultLocale];
};

const initialState = () => {
  const embeddedFallback = getEmbeddedFallback();
  const preference = readLocalePreference();
  const manifest = readCachedManifest()?.manifest ?? embeddedManifest;
  const locale = resolveLocalePreference(preference, manifest, browserPreferredLocales());
  const retainedExplicit = preference === 'system'
    ? undefined
    : readCachedBundle(preference)?.bundle;
  const cached = retainedExplicit ?? readCachedBundle(locale)?.bundle;
  return {
    preference,
    manifest,
    bundle: cached ?? embeddedFallback
  };
};

export interface LocalizationContextValue {
  locale: string;
  systemLocale: string;
  preference: LocalePreference;
  availableLocales: LocalizationManifestLocale[];
  pendingPreference?: LocalePreference;
  errorPreference?: LocalePreference;
  t: (key: MessageKey, variables?: MessageVariables) => string;
  selectPreference: (preference: LocalePreference) => Promise<boolean>;
  clearSelectionError: () => void;
}

const formatMessage = (
  bundle: LocalizationBundle,
  key: MessageKey,
  variables?: MessageVariables
) => {
  const embeddedFallback = getEmbeddedFallback();
  const message = bundle.messages[key] ?? embeddedFallback.messages[key];
  const cacheKey = `${bundle.locale}\u0000${key}\u0000${message}`;
  let formatter = formatterCache.get(cacheKey);
  if (!formatter) {
    if (!MessageFormatter) throw new Error('The localization message formatter is not installed.');
    formatter = new MessageFormatter(message, bundle.locale, undefined, { ignoreTag: true });
    formatterCache.set(cacheKey, formatter);
  }
  return String(formatter.format(variables));
};

const defaultContext: LocalizationContextValue = {
  locale: embeddedManifest.defaultLocale,
  systemLocale: embeddedManifest.defaultLocale,
  preference: embeddedManifest.defaultLocale,
  availableLocales: embeddedManifest.locales,
  t: (key, variables) => formatMessage(getEmbeddedFallback(), key, variables),
  selectPreference: async () => false,
  clearSelectionError: () => undefined
};

const LocalizationContext = createContext<LocalizationContextValue>(defaultContext);

/** Owns the account-independent locale preference and last-known-good runtime bundle. */
export const LocalizationProvider = ({ children }: { children: ReactNode }) => {
  const embeddedFallback = getEmbeddedFallback();
  const [state, setState] = useState(initialState);
  const [systemLocales, setSystemLocales] = useState(browserPreferredLocales);
  const [pendingPreference, setPendingPreference] = useState<LocalePreference>();
  const [errorPreference, setErrorPreference] = useState<LocalePreference>();
  const generation = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;

  const activate = useCallback(async (
    preference: LocalePreference,
    options: { persist: boolean; surfaceError: boolean }
  ) => {
    const requestGeneration = ++generation.current;
    if (options.surfaceError) {
      setPendingPreference(preference);
      setErrorPreference(undefined);
    }

    let manifest = stateRef.current.manifest;
    try {
      const loader = await import('./localizationLoader');
      manifest = await loader.fetchLocalizationManifest();
    } catch {
      // A cached or release-embedded manifest remains authoritative offline.
    }
    const publishedPreference = preference === 'system'
      || manifest.locales.some(({ locale }) => locale === preference);
    if (!publishedPreference) {
      const current = stateRef.current;
      const retained = current.bundle.locale === preference
        ? current.bundle
        : readCachedBundle(preference)?.bundle ?? embeddedFallback;
      if (requestGeneration !== generation.current) return false;
      if (options.persist) writeLocalePreference(preference);
      setState({ preference, manifest, bundle: retained });
      setErrorPreference(undefined);
      if (options.surfaceError) setPendingPreference(undefined);
      return true;
    }
    const targetLocale = resolveLocalePreference(
      preference,
      manifest,
      browserPreferredLocales()
    );

    try {
      const loader = await import('./localizationLoader');
      const bundle = await loader.loadLocalizationBundle(targetLocale, manifest);
      if (requestGeneration !== generation.current) return false;
      if (options.persist) {
        writeLocalePreference(preference);
      }
      setState({ preference, manifest, bundle });
      setErrorPreference(undefined);
      return true;
    } catch {
      if (requestGeneration !== generation.current) return false;
      if (preference === 'system') {
        if (options.persist) writeLocalePreference('system');
        setState({
          preference: 'system',
          manifest,
          bundle: stateRef.current.bundle
        });
        setErrorPreference(undefined);
        return true;
      }
      if (options.surfaceError) setErrorPreference(preference);
      return false;
    } finally {
      if (requestGeneration === generation.current && options.surfaceError) {
        setPendingPreference(undefined);
      }
    }
  }, []);

  useEffect(() => {
    void activate(stateRef.current.preference, { persist: false, surfaceError: false });
  }, [activate]);

  useEffect(() => {
    const handleLanguageChange = () => {
      setSystemLocales(browserPreferredLocales());
      if (stateRef.current.preference === 'system') {
        void activate('system', { persist: false, surfaceError: false });
      }
    };
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== localizationPreferenceStorageKey) return;
      void activate(readLocalePreference(), { persist: false, surfaceError: false });
    };
    window.addEventListener('languagechange', handleLanguageChange);
    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener('languagechange', handleLanguageChange);
      window.removeEventListener('storage', handleStorage);
    };
  }, [activate]);

  useLayoutEffect(() => {
    document.documentElement.lang = state.bundle.locale;
    document.documentElement.dir = directionForLocale(state.bundle.locale);
  }, [state.bundle.locale]);

  const value = useMemo<LocalizationContextValue>(() => ({
    locale: state.bundle.locale,
    systemLocale: resolveLocalePreference('system', state.manifest, systemLocales),
    preference: state.preference,
    availableLocales: state.manifest.locales,
    pendingPreference,
    errorPreference,
    t: (key, variables) => formatMessage(state.bundle, key, variables),
    selectPreference: (preference) => activate(preference, {
      persist: true,
      surfaceError: true
    }),
    clearSelectionError: () => setErrorPreference(undefined)
  }), [activate, errorPreference, pendingPreference, state, systemLocales]);

  return <LocalizationContext.Provider value={value}>{children}</LocalizationContext.Provider>;
};

export const useLocalization = () => useContext(LocalizationContext);

/** Returns localized names for released locales while supporting future manifest entries. */
export const localeDisplayName = (
  locale: string,
  displayLocale: string,
  t: LocalizationContextValue['t']
) => {
  if (locale === 'en-US') return t('language.name.en_us');
  if (locale === 'zh-Hans') return t('language.name.zh_hans');
  try {
    return new Intl.DisplayNames([displayLocale], { type: 'language' }).of(locale) ?? locale;
  } catch {
    return locale;
  }
};
