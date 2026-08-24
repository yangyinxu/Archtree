import type { LocalizationManifest } from './contract';

const canonicalLocale = (locale: string) => {
  try {
    return Intl.getCanonicalLocales(locale)[0];
  } catch {
    return undefined;
  }
};

const localeParts = (locale: string) => {
  try {
    const maximized = new Intl.Locale(locale).maximize();
    return {
      language: maximized.language,
      script: maximized.script,
      region: maximized.region
    };
  } catch {
    return undefined;
  }
};

/** Matches ordered browser preferences to a published locale using likely subtags. */
export const matchSupportedLocale = (
  requestedLocales: readonly string[],
  manifest: LocalizationManifest
) => {
  const supported = manifest.locales.map(({ locale }) => ({
    locale,
    canonical: canonicalLocale(locale),
    parts: localeParts(locale)
  }));

  for (const requested of requestedLocales) {
    const canonical = canonicalLocale(requested);
    if (!canonical) continue;
    const exact = supported.find((candidate) => candidate.canonical === canonical);
    if (exact) return exact.locale;

    const requestedParts = localeParts(canonical);
    if (!requestedParts) continue;
    const sameLanguageAndScript = supported.find((candidate) =>
      candidate.parts?.language === requestedParts.language
      && candidate.parts.script === requestedParts.script);
    if (sameLanguageAndScript) return sameLanguageAndScript.locale;
    const sameLanguage = supported.find((candidate) =>
      candidate.parts?.language === requestedParts.language);
    if (sameLanguage) return sameLanguage.locale;
  }
  return manifest.defaultLocale;
};

/** Resolves the automatic browser preference without coupling it to an account session. */
export const resolveLocalePreference = (
  preference: string,
  manifest: LocalizationManifest,
  systemLocales: readonly string[]
) => {
  if (preference === 'system') return matchSupportedLocale(systemLocales, manifest);
  return manifest.locales.some(({ locale }) => locale === preference)
    ? preference
    : manifest.defaultLocale;
};

/** Keeps document direction synchronized with the active language. */
export const directionForLocale = (locale: string): 'ltr' | 'rtl' => {
  try {
    const language = new Intl.Locale(locale).language;
    return ['ar', 'ckb', 'dv', 'fa', 'he', 'ku', 'ps', 'sd', 'ug', 'ur', 'yi'].includes(language)
      ? 'rtl'
      : 'ltr';
  } catch {
    return 'ltr';
  }
};
