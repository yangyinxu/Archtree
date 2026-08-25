import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse, TYPE } from '@formatjs/icu-messageformat-parser';

const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const supportedDeliveryTargets = new Set([
  'runtime',
  'ios-system',
  'android-system'
]);
const supportedVariableTypes = new Set(['string', 'number', 'date', 'time']);
const maxLocaleBytes = 256 * 1024;
const maxMessageKeys = 1_000;
const maxMessageKeyLength = 160;
const maxMessageLength = 4_000;
const maxLocaleNameLength = 100;

const canonicalJson = (value) => `${JSON.stringify(value, null, 2)}\n`;
const sorted = (values) => [...values].sort((left, right) => left.localeCompare(right));

const assertSorted = (values, label) => {
  const expected = sorted(values);
  if (values.some((value, index) => value !== expected[index])) {
    throw new Error(`${label} must be sorted.`);
  }
};

const readCanonicalJson = async (filePath, label, maxBytes = maxLocaleBytes) => {
  const fileStat = await stat(filePath);
  if (!fileStat.isFile() || fileStat.size === 0 || fileStat.size > maxBytes) {
    throw new Error(`${label} must be a non-empty JSON file no larger than ${maxBytes} bytes.`);
  }
  const raw = await readFile(filePath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${label} must contain valid UTF-8 JSON.`);
  }
  if (raw !== canonicalJson(parsed)) {
    throw new Error(`${label} must use canonical two-space JSON without duplicate keys.`);
  }
  return parsed;
};

const assertRecord = (value, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value;
};

const hasExactKeys = (value, keys) => {
  const actual = sorted(Object.keys(value));
  const expected = sorted(keys);
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
};

const canonicalLocaleTag = (tag, label) => {
  let canonical;
  try {
    [canonical] = Intl.getCanonicalLocales(tag);
  } catch {
    throw new Error(`${label} is not a valid BCP 47 tag: ${tag}`);
  }
  if (canonical !== tag) {
    throw new Error(`${label} must use canonical BCP 47 casing: ${canonical}`);
  }
  return canonical;
};

const validateLocaleName = (value, label) => {
  if (typeof value !== 'string'
    || value.trim() !== value
    || value.length === 0
    || value.length > maxLocaleNameLength
    || /[\u0000-\u001f\u007f<>]/u.test(value)) {
    throw new Error(`${label} must be bounded, plain text without surrounding whitespace.`);
  }
  return value;
};

const inferMessageVariables = (elements, label) => {
  const variables = new Map();
  const recordVariable = (name, type) => {
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error(`${label} contains an invalid variable name.`);
    }
    const existing = variables.get(name);
    if (existing && type && existing !== type) {
      throw new Error(`${label} uses ${name} with incompatible formatter types.`);
    }
    if (type || !existing) variables.set(name, type ?? null);
  };
  const visit = (items) => {
    for (const element of items) {
      switch (element.type) {
        case TYPE.literal:
        case TYPE.pound:
          break;
        case TYPE.argument:
          recordVariable(element.value, null);
          break;
        case TYPE.number:
          recordVariable(element.value, 'number');
          break;
        case TYPE.date:
          recordVariable(element.value, 'date');
          break;
        case TYPE.time:
          recordVariable(element.value, 'time');
          break;
        case TYPE.select:
          recordVariable(element.value, 'string');
          if (!Object.hasOwn(element.options, 'other')) {
            throw new Error(`${label} select messages must include an other branch.`);
          }
          for (const option of Object.values(element.options)) visit(option.value);
          break;
        case TYPE.plural:
          recordVariable(element.value, 'number');
          if (!Object.hasOwn(element.options, 'other')) {
            throw new Error(`${label} plural messages must include an other branch.`);
          }
          for (const option of Object.values(element.options)) visit(option.value);
          break;
        case TYPE.tag:
          throw new Error(`${label} must contain plain text rather than rich-text tags.`);
        default:
          throw new Error(`${label} contains an unsupported ICU element.`);
      }
    }
  };
  visit(elements);
  return variables;
};

const validateCatalog = (catalog) => {
  const root = assertRecord(catalog, 'catalog.json');
  if (!hasExactKeys(root, ['schemaVersion', 'locales', 'messages'])) {
    throw new Error('catalog.json must contain only schemaVersion, locales, and messages.');
  }
  if (root.schemaVersion !== 1) throw new Error('catalog.json schemaVersion must be 1.');
  const locales = assertRecord(root.locales, 'catalog.json locales');
  const localeTags = Object.keys(locales);
  if (localeTags.length === 0 || localeTags.length > 100) {
    throw new Error('catalog.json must contain 1–100 locale metadata entries.');
  }
  assertSorted(localeTags, 'catalog.json locale metadata');
  for (const locale of localeTags) {
    canonicalLocaleTag(locale, 'catalog.json locale metadata');
    const entry = assertRecord(locales[locale], `catalog locale ${locale}`);
    if (!hasExactKeys(entry, ['nativeName', 'englishName'])) {
      throw new Error(`catalog locale ${locale} must contain nativeName and englishName.`);
    }
    validateLocaleName(entry.nativeName, `catalog locale ${locale} nativeName`);
    validateLocaleName(entry.englishName, `catalog locale ${locale} englishName`);
  }
  const messages = assertRecord(root.messages, 'catalog.json messages');
  const keys = Object.keys(messages);
  if (keys.length === 0 || keys.length > maxMessageKeys) {
    throw new Error(`catalog.json must contain 1–${maxMessageKeys} messages.`);
  }
  assertSorted(keys, 'catalog.json message keys');

  for (const key of keys) {
    if (key.length > maxMessageKeyLength || !/^[a-z0-9]+(?:[._][a-z0-9]+)*$/.test(key)) {
      throw new Error(`catalog.json contains an invalid semantic key: ${key}`);
    }
    const entry = assertRecord(messages[key], `catalog entry ${key}`);
    if (typeof entry.description !== 'string'
      || entry.description.trim().length === 0
      || entry.description.length > 500) {
      throw new Error(`catalog entry ${key} requires a bounded translator description.`);
    }
    if (!Array.isArray(entry.delivery)
      || entry.delivery.length === 0
      || entry.delivery.some((target) => !supportedDeliveryTargets.has(target))
      || new Set(entry.delivery).size !== entry.delivery.length) {
      throw new Error(`catalog entry ${key} contains invalid delivery targets.`);
    }
    assertSorted(entry.delivery, `catalog entry ${key} delivery targets`);
    const variables = assertRecord(entry.variables, `catalog entry ${key} variables`);
    const variableNames = Object.keys(variables);
    assertSorted(variableNames, `catalog entry ${key} variables`);
    for (const name of variableNames) {
      if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name) || !supportedVariableTypes.has(variables[name])) {
        throw new Error(`catalog entry ${key} contains an invalid variable contract.`);
      }
    }
  }
  return { locales, messages };
};

const validateLocaleMessages = (locale, messages, catalogMessages) => {
  const localeMessages = assertRecord(messages, `${locale}.json`);
  const keys = Object.keys(localeMessages);
  const catalogKeys = Object.keys(catalogMessages);
  assertSorted(keys, `${locale}.json message keys`);
  if (keys.length !== catalogKeys.length
    || keys.some((key, index) => key !== catalogKeys[index])) {
    throw new Error(`${locale}.json must contain exactly the catalog message-key set.`);
  }

  for (const key of keys) {
    const message = localeMessages[key];
    if (typeof message !== 'string' || message.length === 0 || message.length > maxMessageLength) {
      throw new Error(`${locale}.json message ${key} must be a bounded non-empty string.`);
    }
    let elements;
    try {
      elements = parse(message, { requiresOtherClause: true });
    } catch (error) {
      throw new Error(`${locale}.json message ${key} is invalid ICU MessageFormat: ${error.message}`);
    }
    const inferred = inferMessageVariables(elements, `${locale}.json message ${key}`);
    const expected = catalogMessages[key].variables;
    const expectedNames = Object.keys(expected);
    const inferredNames = sorted(inferred.keys());
    if (expectedNames.length !== inferredNames.length
      || expectedNames.some((name, index) => name !== inferredNames[index])) {
      throw new Error(`${locale}.json message ${key} does not match its named-variable set.`);
    }
    for (const name of expectedNames) {
      const explicitType = inferred.get(name);
      if (explicitType && explicitType !== expected[name]) {
        throw new Error(`${locale}.json message ${key} formats ${name} as ${explicitType}, not ${expected[name]}.`);
      }
    }
  }
  return localeMessages;
};

const canonicalLocale = (filename) => {
  const tag = filename.replace(/\.json$/, '');
  const canonical = canonicalLocaleTag(tag, 'Locale filename');
  if (`${canonical}.json` !== filename) {
    throw new Error(`Locale filename must use canonical BCP 47 casing: ${canonical}.json`);
  }
  return canonical;
};

const revisionFor = (messages) => {
  const digest = createHash('sha256').update(JSON.stringify(messages)).digest('base64url');
  return `sha256-${digest}`;
};

/** Validates canonical sources and returns deterministic runtime artifacts. */
export const buildLocalizationArtifacts = async (root = repositoryRoot) => {
  const localizationRoot = path.join(root, 'localization');
  const catalog = await readCanonicalJson(
    path.join(localizationRoot, 'catalog.json'),
    'catalog.json',
    512 * 1024
  );
  const { locales: localeMetadata, messages: catalogMessages } = validateCatalog(catalog);
  const localeRoot = path.join(localizationRoot, 'locales');
  const filenames = sorted((await readdir(localeRoot)).filter((name) => name.endsWith('.json')));
  if (filenames.length === 0) throw new Error('At least one locale JSON file is required.');
  const sourceLocales = filenames.map(canonicalLocale);
  const metadataLocales = Object.keys(localeMetadata);
  if (sourceLocales.length !== metadataLocales.length
    || sourceLocales.some((locale, index) => locale !== metadataLocales[index])) {
    throw new Error('catalog.json locale metadata must exactly match the locale JSON files.');
  }

  const bundles = new Map();
  for (const [index, filename] of filenames.entries()) {
    const locale = sourceLocales[index];
    const messages = validateLocaleMessages(
      locale,
      await readCanonicalJson(path.join(localeRoot, filename), filename),
      catalogMessages
    );
    const runtimeMessages = Object.fromEntries(Object.keys(messages)
      .filter((key) => catalogMessages[key].delivery.includes('runtime'))
      .map((key) => [key, messages[key]]));
    const revision = revisionFor(runtimeMessages);
    bundles.set(locale, {
      schemaVersion: 1,
      locale,
      revision,
      messages: runtimeMessages
    });
  }

  if (!bundles.has('en-US')) throw new Error('The required en-US fallback locale is missing.');
  return {
    manifest: {
      schemaVersion: 1,
      defaultLocale: 'en-US',
      locales: [...bundles.values()].map(({ locale, revision }) => ({
        locale,
        nativeName: localeMetadata[locale].nativeName,
        englishName: localeMetadata[locale].englishName,
        revision
      }))
    },
    bundles
  };
};

const atomicWrite = async (filePath, contents) => {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  await writeFile(temporaryPath, contents, 'utf8');
  await rename(temporaryPath, filePath);
};

const expectedGeneratedFiles = (artifacts, root) => {
  const generatedRoot = path.join(root, 'localization', 'generated');
  return new Map([
    [path.join(generatedRoot, 'manifest.json'), canonicalJson(artifacts.manifest)],
    ...[...artifacts.bundles].map(([locale, bundle]) => [
      path.join(generatedRoot, 'bundles', `${locale}.json`),
      canonicalJson(bundle)
    ])
  ]);
};

/** Writes only deterministic localization artifacts and removes stale bundle files. */
export const writeLocalizationArtifacts = async (root = repositoryRoot) => {
  const artifacts = await buildLocalizationArtifacts(root);
  const expectedFiles = expectedGeneratedFiles(artifacts, root);
  for (const [filePath, contents] of expectedFiles) await atomicWrite(filePath, contents);

  const bundleRoot = path.join(root, 'localization', 'generated', 'bundles');
  for (const filename of await readdir(bundleRoot)) {
    const filePath = path.join(bundleRoot, filename);
    if (filename.endsWith('.json') && !expectedFiles.has(filePath)) await unlink(filePath);
  }
  return artifacts;
};

/** Fails when committed generated files do not match the canonical sources. */
export const checkLocalizationArtifacts = async (root = repositoryRoot) => {
  const artifacts = await buildLocalizationArtifacts(root);
  const expectedFiles = expectedGeneratedFiles(artifacts, root);
  for (const [filePath, expected] of expectedFiles) {
    let actual;
    try {
      actual = await readFile(filePath, 'utf8');
    } catch {
      throw new Error(`Generated localization artifact is missing: ${path.relative(root, filePath)}`);
    }
    if (actual !== expected) {
      throw new Error(`Generated localization artifact is stale: ${path.relative(root, filePath)}`);
    }
  }
  const bundleRoot = path.join(root, 'localization', 'generated', 'bundles');
  for (const filename of await readdir(bundleRoot)) {
    const filePath = path.join(bundleRoot, filename);
    if (filename.endsWith('.json') && !expectedFiles.has(filePath)) {
      throw new Error(`Generated localization artifact is stale: ${path.relative(root, filePath)}`);
    }
  }
  return artifacts;
};

const runCli = async () => {
  const checkOnly = process.argv.includes('--check');
  try {
    const artifacts = checkOnly
      ? await checkLocalizationArtifacts()
      : await writeLocalizationArtifacts();
    process.stdout.write(
      `${checkOnly ? 'Validated' : 'Generated'} ${artifacts.bundles.size} localization bundles.\n`
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runCli();
}
