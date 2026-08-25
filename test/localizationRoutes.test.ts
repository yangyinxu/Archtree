import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Server } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createApp } from '../src/app';
import { resetRateLimitWindowsForTests } from '../src/middleware/requestProtectionMiddleware';

const close = (server: Server) => new Promise<void>((resolve, reject) => {
  server.close((error) => error ? reject(error) : resolve());
});

const listen = async (localizationDistPath: string) => {
  resetRateLimitWindowsForTests();
  const app = createApp({
    environment: 'test',
    listenerDistPath: path.join(localizationDistPath, 'missing-listener'),
    localizationDistPath
  });
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
};

const enMessages = { 'shell.nav.home': 'Home' };
const zhMessages = { 'shell.nav.home': '首页' };
const revisionFor = (messages: Record<string, string>) =>
  `sha256-${createHash('sha256').update(JSON.stringify(messages)).digest('base64url')}`;
const enRevision = revisionFor(enMessages);
const zhRevision = revisionFor(zhMessages);
const manifestFixture = {
  schemaVersion: 1,
  defaultLocale: 'en-US',
  locales: [
    {
      locale: 'en-US',
      nativeName: 'English (United States)',
      englishName: 'English (United States)',
      revision: enRevision
    },
    {
      locale: 'zh-Hans',
      nativeName: '简体中文',
      englishName: 'Simplified Chinese',
      revision: zhRevision
    }
  ]
};

const writeArtifacts = async (
  root: string,
  bundleOverride?: unknown,
  manifestOverride?: unknown
) => {
  await mkdir(path.join(root, 'bundles'), { recursive: true });
  await writeFile(
    path.join(root, 'manifest.json'),
    `${JSON.stringify(manifestOverride ?? manifestFixture, null, 2)}\n`
  );
  await writeFile(path.join(root, 'bundles', 'en-US.json'), `${JSON.stringify(
    bundleOverride ?? {
      schemaVersion: 1,
      locale: 'en-US',
      revision: enRevision,
      messages: enMessages
    },
    null,
    2
  )}\n`);
  await writeFile(path.join(root, 'bundles', 'zh-Hans.json'), `${JSON.stringify({
    schemaVersion: 1,
    locale: 'zh-Hans',
    revision: zhRevision,
    messages: zhMessages
  }, null, 2)}\n`);
};

test('localization endpoints publish bounded JSON with conditional caching', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'archtree-localizations-'));
  await writeArtifacts(temporaryRoot);
  const { server, baseUrl } = await listen(temporaryRoot);

  try {
    const manifest = await fetch(`${baseUrl}/api/localizations/v1/manifest`);
    assert.equal(manifest.status, 200);
    assert.match(manifest.headers.get('content-type') ?? '', /application\/json/);
    assert.equal(manifest.headers.get('cache-control'), 'public, max-age=0, must-revalidate');
    assert.equal(manifest.headers.get('access-control-allow-origin'), '*');
    assert.match(manifest.headers.get('access-control-expose-headers') ?? '', /Content-Language/);
    const manifestEtag = manifest.headers.get('etag');
    assert.ok(manifestEtag?.startsWith('"sha256-'));
    const manifestBody = await manifest.json();
    assert.equal(manifestBody.defaultLocale, 'en-US');
    assert.deepEqual(manifestBody.locales.map((entry: Record<string, unknown>) => ({
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

    const unchangedManifest = await fetch(`${baseUrl}/api/localizations/v1/manifest`, {
      headers: { 'If-None-Match': `W/${manifestEtag}` }
    });
    assert.equal(unchangedManifest.status, 304);
    assert.equal(await unchangedManifest.text(), '');

    const bundle = await fetch(`${baseUrl}/api/localizations/v1/bundles/zh-Hans`);
    assert.equal(bundle.status, 200);
    assert.equal(bundle.headers.get('content-language'), 'zh-Hans');
    assert.equal(bundle.headers.get('cache-control'), 'public, max-age=0, must-revalidate');
    assert.deepEqual((await bundle.json()).messages, { 'shell.nav.home': '首页' });

    const unknown = await fetch(`${baseUrl}/api/localizations/v1/bundles/fr-FR`);
    assert.equal(unknown.status, 404);
    assert.equal(unknown.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await unknown.json(), { message: 'Localization bundle not found.' });
  } finally {
    await close(server);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('invalid locale display metadata fails closed', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'archtree-localizations-metadata-'));
  await writeArtifacts(temporaryRoot, undefined, {
    ...manifestFixture,
    locales: manifestFixture.locales.map((entry) => entry.locale === 'zh-Hans'
      ? { ...entry, englishName: '' }
      : entry)
  });
  const { server, baseUrl } = await listen(temporaryRoot);
  const originalConsoleError = console.error;
  console.error = () => undefined;

  try {
    const response = await fetch(`${baseUrl}/api/localizations/v1/manifest`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      message: 'The service could not complete the request.'
    });
  } finally {
    console.error = originalConsoleError;
    await close(server);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('invalid generated bundles fail closed without leaking artifact details', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'archtree-localizations-invalid-'));
  await writeArtifacts(temporaryRoot, {
    schemaVersion: 1,
    locale: 'fr-FR',
    revision: enRevision,
    messages: enMessages
  });
  const { server, baseUrl } = await listen(temporaryRoot);
  const originalConsoleError = console.error;
  console.error = () => undefined;

  try {
    const response = await fetch(`${baseUrl}/api/localizations/v1/bundles/en-US`);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), null);
    assert.deepEqual(await response.json(), {
      message: 'The service could not complete the request.'
    });
  } finally {
    console.error = originalConsoleError;
    await close(server);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
