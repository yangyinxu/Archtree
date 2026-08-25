import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const maxManifestBytes = 64 * 1024;
const maxBundleBytes = 256 * 1024;
const maxLocaleNameLength = 100;
const localePattern = /^[A-Za-z0-9-]+$/;
const revisionPattern = /^sha256-[A-Za-z0-9_-]{43}$/;

export interface LocalizationManifestLocale {
  locale: string;
  nativeName: string;
  englishName: string;
  revision: string;
}

export interface LocalizationManifest {
  schemaVersion: 1;
  defaultLocale: string;
  locales: LocalizationManifestLocale[];
}

export interface LocalizationRepresentation {
  body: Buffer;
  etag: string;
  locale?: string;
}

/** Signals that generated localization artifacts are missing or fail their publication contract. */
export class LocalizationArtifactError extends Error {
  readonly statusCode = 503;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]) => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
};

const readJsonRepresentation = (
  filePath: string,
  maximumBytes: number,
  label: string
): { body: Buffer; value: unknown; etag: string } => {
  let body: Buffer;
  try {
    body = fs.readFileSync(filePath);
  } catch {
    throw new LocalizationArtifactError(`${label} is unavailable.`);
  }
  if (body.length === 0 || body.length > maximumBytes) {
    throw new LocalizationArtifactError(`${label} has an invalid size.`);
  }

  let value: unknown;
  try {
    value = JSON.parse(body.toString('utf8'));
  } catch {
    throw new LocalizationArtifactError(`${label} is not valid JSON.`);
  }
  const digest = crypto.createHash('sha256').update(body).digest('base64url');
  return { body, value, etag: `"sha256-${digest}"` };
};

const validateLocaleTag = (value: unknown): value is string => {
  if (typeof value !== 'string'
    || value.length < 2
    || value.length > 64
    || !localePattern.test(value)) return false;
  try {
    const [canonical] = Intl.getCanonicalLocales(value);
    return canonical === value;
  } catch {
    return false;
  }
};

const validateLocaleName = (value: unknown): value is string =>
  typeof value === 'string'
  && value.length > 0
  && value.length <= maxLocaleNameLength
  && value.trim() === value
  && !/[\u0000-\u001f\u007f<>]/u.test(value);

const validateManifest = (value: unknown): LocalizationManifest => {
  if (!isRecord(value)
    || !hasExactKeys(value, ['schemaVersion', 'defaultLocale', 'locales'])
    || value.schemaVersion !== 1
    || value.defaultLocale !== 'en-US'
    || !validateLocaleTag(value.defaultLocale)
    || !Array.isArray(value.locales)
    || value.locales.length === 0
    || value.locales.length > 100) {
    throw new LocalizationArtifactError('The localization manifest is invalid.');
  }

  const locales: LocalizationManifestLocale[] = [];
  const seen = new Set<string>();
  for (const entry of value.locales) {
    if (!isRecord(entry)
      || !hasExactKeys(entry, ['locale', 'nativeName', 'englishName', 'revision'])
      || !validateLocaleTag(entry.locale)
      || !validateLocaleName(entry.nativeName)
      || !validateLocaleName(entry.englishName)
      || typeof entry.revision !== 'string'
      || !revisionPattern.test(entry.revision)
      || seen.has(entry.locale)) {
      throw new LocalizationArtifactError('The localization manifest contains an invalid locale.');
    }
    seen.add(entry.locale);
    locales.push({
      locale: entry.locale,
      nativeName: entry.nativeName,
      englishName: entry.englishName,
      revision: entry.revision
    });
  }
  if (!seen.has(value.defaultLocale)) {
    throw new LocalizationArtifactError('The localization manifest default locale is unavailable.');
  }
  return { schemaVersion: 1, defaultLocale: value.defaultLocale, locales };
};

const validateBundle = (
  value: unknown,
  expected: LocalizationManifestLocale
) => {
  if (!isRecord(value)
    || !hasExactKeys(value, ['schemaVersion', 'locale', 'revision', 'messages'])
    || value.schemaVersion !== 1
    || value.locale !== expected.locale
    || value.revision !== expected.revision
    || !isRecord(value.messages)
    || Object.keys(value.messages).length === 0
    || Object.keys(value.messages).length > 1_000
    || Object.values(value.messages).some((message) =>
      typeof message !== 'string' || message.length === 0 || message.length > 4_000)) {
    throw new LocalizationArtifactError(`The ${expected.locale} localization bundle is invalid.`);
  }
  const actualRevision = `sha256-${crypto.createHash('sha256')
    .update(JSON.stringify(value.messages))
    .digest('base64url')}`;
  if (actualRevision !== expected.revision) {
    throw new LocalizationArtifactError(`The ${expected.locale} localization revision is invalid.`);
  }
};

/** Reads only generated, manifested localization representations from the deployment artifact. */
export class LocalizationService {
  constructor(private readonly generatedRoot = path.resolve(
    __dirname,
    '..',
    '..',
    'localization',
    'generated'
  )) {}

  getManifest(): LocalizationRepresentation {
    const representation = readJsonRepresentation(
      path.join(this.generatedRoot, 'manifest.json'),
      maxManifestBytes,
      'The localization manifest'
    );
    validateManifest(representation.value);
    return { body: representation.body, etag: representation.etag };
  }

  getBundle(locale: string): LocalizationRepresentation | undefined {
    const manifestRepresentation = readJsonRepresentation(
      path.join(this.generatedRoot, 'manifest.json'),
      maxManifestBytes,
      'The localization manifest'
    );
    const manifest = validateManifest(manifestRepresentation.value);
    const expected = manifest.locales.find((entry) => entry.locale === locale);
    if (!expected) return undefined;

    const representation = readJsonRepresentation(
      path.join(this.generatedRoot, 'bundles', `${expected.locale}.json`),
      maxBundleBytes,
      `The ${expected.locale} localization bundle`
    );
    validateBundle(representation.value, expected);
    return {
      body: representation.body,
      etag: representation.etag,
      locale: expected.locale
    };
  }
}
