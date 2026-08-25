import {
  getEmbeddedFallback,
  localizationManifestSchema,
  parseCompatibleBundle,
  type LocalizationBundle,
  type LocalizationManifest
} from './contract';
import {
  readCachedBundle,
  readCachedManifest,
  writeCachedBundle,
  writeCachedManifest
} from './storage';

const maxManifestBytes = 64 * 1024;
const maxBundleBytes = 256 * 1024;

const parseBoundedResponse = async (response: Response, maximumBytes: number) => {
  const declaredLength = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error('The localization response is too large.');
  }
  const body = await response.text();
  if (new TextEncoder().encode(body).length > maximumBytes) {
    throw new Error('The localization response is too large.');
  }
  return JSON.parse(body) as unknown;
};

/** Conditionally refreshes the public locale manifest while retaining a valid cache. */
export const fetchLocalizationManifest = async (): Promise<LocalizationManifest> => {
  const cached = readCachedManifest();
  const response = await fetch('/api/localizations/v1/manifest', {
    headers: cached ? { 'If-None-Match': cached.etag } : undefined
  });
  if (response.status === 304) {
    if (!cached) throw new Error('The localization manifest cache is unavailable.');
    return cached.manifest;
  }
  if (!response.ok) throw new Error('The localization manifest could not be downloaded.');
  const manifest = localizationManifestSchema.parse(
    await parseBoundedResponse(response, maxManifestBytes)
  );
  writeCachedManifest({
    etag: response.headers.get('ETag') ?? `revision-${Date.now()}`,
    manifest
  });
  return manifest;
};

/** Returns only a complete bundle matching the selected manifest revision. */
export const loadLocalizationBundle = async (
  locale: string,
  manifest: LocalizationManifest
): Promise<LocalizationBundle> => {
  const embeddedFallback = getEmbeddedFallback();
  const expected = manifest.locales.find((entry) => entry.locale === locale);
  if (!expected) throw new Error('The selected localization is not published.');
  if (locale === embeddedFallback.locale && expected.revision === embeddedFallback.revision) {
    return embeddedFallback;
  }

  const cached = readCachedBundle(locale);
  if (cached?.bundle.revision === expected.revision) return cached.bundle;
  const response = await fetch(`/api/localizations/v1/bundles/${encodeURIComponent(locale)}`, {
    headers: cached ? { 'If-None-Match': cached.etag } : undefined
  });
  if (response.status === 304) {
    if (!cached || cached.bundle.revision !== expected.revision) {
      throw new Error('The localization cache is out of date.');
    }
    return cached.bundle;
  }
  if (!response.ok) throw new Error('The selected localization could not be downloaded.');
  const bundle = parseCompatibleBundle(await parseBoundedResponse(response, maxBundleBytes));
  if (bundle.locale !== expected.locale || bundle.revision !== expected.revision) {
    throw new Error('The localization response does not match its manifest.');
  }
  writeCachedBundle({ etag: response.headers.get('ETag') ?? bundle.revision, bundle });
  return bundle;
};
