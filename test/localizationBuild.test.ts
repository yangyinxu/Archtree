import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildLocalizationArtifacts } from '../scripts/build-localizations.mjs';
import { syncPackagedNativeLocalizations } from '../scripts/sync-native-localizations.mjs';

const canonicalJson = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const catalog = {
  schemaVersion: 1,
  locales: {
    'en-US': {
      nativeName: 'English (United States)',
      englishName: 'English (United States)'
    },
    'zh-Hans': {
      nativeName: '简体中文',
      englishName: 'Simplified Chinese'
    }
  },
  messages: {
    'common.count': {
      description: 'A localized item count.',
      delivery: ['runtime'],
      variables: { count: 'number' }
    },
    'common.greeting': {
      description: 'A greeting using the listener name.',
      delivery: ['runtime'],
      variables: { name: 'string' }
    }
  }
};

const createFixture = async (
  zhMessages: Record<string, string>,
  fixtureCatalog: unknown = catalog
) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'archtree-localization-build-'));
  const locales = path.join(root, 'localization', 'locales');
  await mkdir(locales, { recursive: true });
  await writeFile(path.join(root, 'localization', 'catalog.json'), canonicalJson(fixtureCatalog));
  await writeFile(path.join(locales, 'en-US.json'), canonicalJson({
    'common.count': '{count, plural, one {# item} other {# items}}',
    'common.greeting': 'Hello, {name}'
  }));
  await writeFile(path.join(locales, 'zh-Hans.json'), canonicalJson(zhMessages));
  return root;
};

test('localization build accepts only aligned, valid locale contracts', async () => {
  const root = await createFixture({
    'common.count': '{count} 项',
    'common.greeting': '你好，{name}'
  });
  try {
    const artifacts = await buildLocalizationArtifacts(root);
    assert.deepEqual([...artifacts.bundles.keys()], ['en-US', 'zh-Hans']);
    assert.deepEqual(artifacts.manifest.locales.map((entry) => ({
      locale: entry.locale,
      nativeName: entry.nativeName,
      englishName: entry.englishName
    })), [
      {
        locale: 'en-US',
        nativeName: 'English (United States)',
        englishName: 'English (United States)'
      },
      {
        locale: 'zh-Hans',
        nativeName: '简体中文',
        englishName: 'Simplified Chinese'
      }
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('localization build rejects missing or malformed locale display metadata', async () => {
  const messages = {
    'common.count': '{count} 项',
    'common.greeting': '你好，{name}'
  };
  const missingRoot = await createFixture(messages, {
    ...catalog,
    locales: {
      'en-US': catalog.locales['en-US']
    }
  });
  try {
    await assert.rejects(
      () => buildLocalizationArtifacts(missingRoot),
      /locale metadata must exactly match the locale JSON files/
    );
  } finally {
    await rm(missingRoot, { recursive: true, force: true });
  }

  const malformedRoot = await createFixture(messages, {
    ...catalog,
    locales: {
      ...catalog.locales,
      'zh-Hans': {
        ...catalog.locales['zh-Hans'],
        englishName: ' '
      }
    }
  });
  try {
    await assert.rejects(
      () => buildLocalizationArtifacts(malformedRoot),
      /zh-Hans englishName must be bounded, plain text/
    );
  } finally {
    await rm(malformedRoot, { recursive: true, force: true });
  }
});

test('localization build rejects missing keys and incompatible variable types', async () => {
  const missingRoot = await createFixture({
    'common.count': '{count} 项'
  });
  try {
    await assert.rejects(
      () => buildLocalizationArtifacts(missingRoot),
      /exactly the catalog message-key set/
    );
  } finally {
    await rm(missingRoot, { recursive: true, force: true });
  }

  const typeRoot = await createFixture({
    'common.count': '{count, date}',
    'common.greeting': '你好，{name}'
  });
  try {
    await assert.rejects(
      () => buildLocalizationArtifacts(typeRoot),
      /formats count as date, not number/
    );
  } finally {
    await rm(typeRoot, { recursive: true, force: true });
  }
});

test('native sync pins the generated manifest and en-US fallback in both clients', async () => {
  const root = await createFixture({
    'common.count': '{count} 项',
    'common.greeting': '你好，{name}'
  });
  const iosRoot = path.join(root, 'clients', 'Finitude_iOS');
  const androidRoot = path.join(root, 'clients', 'Finitude_Android');
  await mkdir(path.join(iosRoot, 'Finitude_iOS.xcodeproj'), { recursive: true });
  await mkdir(androidRoot, { recursive: true });
  await writeFile(path.join(iosRoot, 'Finitude_iOS.xcodeproj', 'project.pbxproj'), '// fixture\n');
  await writeFile(path.join(androidRoot, 'settings.gradle.kts'), '// fixture\n');

  try {
    await syncPackagedNativeLocalizations({ archtreeRoot: root, iosRoot, androidRoot });
    const generatedRoot = path.join(root, 'localization', 'generated');
    const generatedManifest = await readFile(path.join(generatedRoot, 'manifest.json'), 'utf8');
    const generatedFallback = await readFile(
      path.join(generatedRoot, 'bundles', 'en-US.json'),
      'utf8'
    );
    for (const destination of [
      path.join(iosRoot, 'Finitude_iOS', 'Localization'),
      path.join(androidRoot, 'app', 'src', 'main', 'assets', 'localization')
    ]) {
      assert.equal(await readFile(path.join(destination, 'manifest.json'), 'utf8'), generatedManifest);
      assert.equal(await readFile(path.join(destination, 'en-US.json'), 'utf8'), generatedFallback);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
