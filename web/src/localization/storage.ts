import { z } from 'zod';

import {
  embeddedManifest,
  localizationManifestSchema,
  parseCompatibleBundle,
  type LocalePreference,
  type LocalizationBundle,
  type LocalizationManifest
} from './contract';

export const localizationPreferenceStorageKey = 'finitude.localization.preference.v1';
export const defaultWebLocalePreference: LocalePreference = embeddedManifest.defaultLocale;
const manifestStorageKey = 'finitude.localization.manifest.v1';
const bundleStoragePrefix = 'finitude.localization.bundle.v1.';
const maxCachedJsonCharacters = 400_000;

const cachedManifestSchema = z.object({
  etag: z.string().min(1).max(160),
  manifest: localizationManifestSchema
}).strict();

const cachedBundleSchema = z.object({
  etag: z.string().min(1).max(160),
  bundle: z.unknown()
}).strict();

export interface CachedManifest {
  etag: string;
  manifest: LocalizationManifest;
}

export interface CachedBundle {
  etag: string;
  bundle: LocalizationBundle;
}

const readStorageJson = (key: string): unknown => {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw || raw.length > maxCachedJsonCharacters) return undefined;
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
};

const writeStorageJson = (key: string, value: unknown) => {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private browsing and quota failures must never prevent embedded fallback use.
  }
};

export const readLocalePreference = (): LocalePreference => {
  try {
    const value = window.localStorage.getItem(localizationPreferenceStorageKey);
    if (!value) return defaultWebLocalePreference;
    if (value === 'system') {
      window.localStorage.setItem(localizationPreferenceStorageKey, defaultWebLocalePreference);
      return defaultWebLocalePreference;
    }
    return Intl.getCanonicalLocales(value)[0] === value
      ? value
      : defaultWebLocalePreference;
  } catch {
    return defaultWebLocalePreference;
  }
};

export const writeLocalePreference = (preference: LocalePreference) => {
  try {
    window.localStorage.setItem(localizationPreferenceStorageKey, preference);
  } catch {
    // The in-memory preference remains usable when storage is unavailable.
  }
};

export const readCachedManifest = (): CachedManifest | undefined => {
  const parsed = cachedManifestSchema.safeParse(readStorageJson(manifestStorageKey));
  return parsed.success ? parsed.data : undefined;
};

export const writeCachedManifest = (cache: CachedManifest) =>
  writeStorageJson(manifestStorageKey, cache);

const bundleStorageKey = (locale: string) => `${bundleStoragePrefix}${locale}`;

export const readCachedBundle = (locale: string): CachedBundle | undefined => {
  const parsed = cachedBundleSchema.safeParse(readStorageJson(bundleStorageKey(locale)));
  if (!parsed.success) return undefined;
  try {
    const bundle = parseCompatibleBundle(parsed.data.bundle);
    return bundle.locale === locale
      ? { etag: parsed.data.etag, bundle }
      : undefined;
  } catch {
    return undefined;
  }
};

export const writeCachedBundle = (cache: CachedBundle) =>
  writeStorageJson(bundleStorageKey(cache.bundle.locale), cache);
