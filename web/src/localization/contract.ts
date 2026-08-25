import { z } from 'zod';

import type embeddedFallbackJson from '../../../localization/generated/bundles/en-US.json';
import embeddedManifestJson from '../../../localization/generated/manifest.json';

const revisionSchema = z.string().regex(/^sha256-[A-Za-z0-9_-]{43}$/);
const localeNameSchema = z.string().min(1).max(100).refine((value) => (
  value.trim() === value && !/[\u0000-\u001f\u007f<>]/u.test(value)
), 'Locale names must be plain text without surrounding whitespace.');
const localeSchema = z.string().min(2).max(64).refine((value) => {
  try {
    return Intl.getCanonicalLocales(value)[0] === value;
  } catch {
    return false;
  }
}, 'Locale tags must use canonical BCP 47 casing.');

export const localizationManifestSchema = z.object({
  schemaVersion: z.literal(1),
  defaultLocale: localeSchema,
  locales: z.array(z.object({
    locale: localeSchema,
    nativeName: localeNameSchema,
    englishName: localeNameSchema,
    revision: revisionSchema
  }).strict()).min(1).max(100)
}).strict().superRefine((manifest, context) => {
  const locales = manifest.locales.map(({ locale }) => locale);
  if (new Set(locales).size !== locales.length) {
    context.addIssue({ code: 'custom', message: 'Locale tags must be unique.' });
  }
  if (!locales.includes(manifest.defaultLocale)) {
    context.addIssue({ code: 'custom', message: 'The default locale must be published.' });
  }
});

export const localizationBundleSchema = z.object({
  schemaVersion: z.literal(1),
  locale: localeSchema,
  revision: revisionSchema,
  messages: z.record(z.string().min(1).max(160), z.string().min(1).max(4_000))
}).strict();

export type LocalizationManifest = z.infer<typeof localizationManifestSchema>;
export type LocalizationManifestLocale = LocalizationManifest['locales'][number];
export type LocalizationBundle = z.infer<typeof localizationBundleSchema>;
export type LocalePreference = 'system' | string;
export type MessageKey = keyof typeof embeddedFallbackJson.messages;
export type MessageVariables = Record<string, string | number | Date>;
type BundleMessageValidator = (
  bundle: LocalizationBundle,
  fallback: LocalizationBundle
) => void;

const embeddedManifest = localizationManifestSchema.parse(embeddedManifestJson);
let embeddedFallback: LocalizationBundle | undefined;
let bundleMessageValidator: BundleMessageValidator | undefined;

/** Installs the separately packaged fallback before any listener UI renders. */
export const installEmbeddedFallback = (value: unknown) => {
  const fallback = localizationBundleSchema.parse(value);
  const expected = embeddedManifest.locales.find(({ locale }) => (
    locale === embeddedManifest.defaultLocale
  ));
  if (!expected
    || fallback.locale !== embeddedManifest.defaultLocale
    || fallback.revision !== expected.revision) {
    throw new Error('The packaged localization fallback does not match its manifest.');
  }
  embeddedFallback = fallback;
};

/** Returns the validated fallback after application bootstrap has installed it. */
export const getEmbeddedFallback = () => {
  if (!embeddedFallback) throw new Error('The packaged localization fallback is not installed.');
  return embeddedFallback;
};

/** Installs the ICU compatibility validator before cached or remote bundles are read. */
export const installBundleMessageValidator = (validator: BundleMessageValidator) => {
  bundleMessageValidator = validator;
};

/** Rejects remote bundles that cannot satisfy every key compiled into this Web release. */
export const parseCompatibleBundle = (value: unknown): LocalizationBundle => {
  const bundle = localizationBundleSchema.parse(value);
  const fallback = getEmbeddedFallback();
  const embeddedKeys = Object.keys(fallback.messages);
  if (embeddedKeys.some((key) => typeof bundle.messages[key] !== 'string')) {
    throw new Error('The localization bundle is incompatible with this Finitude release.');
  }
  bundleMessageValidator?.(bundle, fallback);
  return bundle;
};

export { embeddedManifest };
