import assert from 'node:assert/strict';
import { Server } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createApp } from '../src/app';

const listen = async (listenerDistPath: string) => {
  const app = createApp({ listenerDistPath, environment: 'test' });
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`
  };
};

const close = (server: Server) => new Promise<void>((resolve, reject) => {
  server.close((error) => error ? reject(error) : resolve());
});

/** Verifies the deployment-wide policy without coupling tests to header ordering. */
const assertSecurityHeaders = (response: Response, options: { inlineStyles?: boolean } = {}) => {
  const csp = response.headers.get('content-security-policy') ?? '';
  for (const directive of [
    "default-src 'self'",
    "base-uri 'none'",
    "connect-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data: blob: https:",
    "media-src 'self'",
    "object-src 'none'",
    "script-src 'self'",
    "script-src-attr 'none'"
  ]) {
    assert.match(csp, new RegExp(directive.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  if (options.inlineStyles) {
    assert.match(csp, /style-src 'self' 'unsafe-inline'/);
    assert.match(csp, /style-src-attr 'unsafe-inline'/);
  } else {
    assert.match(csp, /(?:^|; )style-src 'self'(?:;|$)/);
    assert.match(csp, /style-src-attr 'none'/);
    assert.doesNotMatch(csp, /unsafe-inline/);
  }
  assert.equal(response.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('x-powered-by'), null);
  const permissions = response.headers.get('permissions-policy') ?? '';
  assert.match(permissions, /autoplay=\(self\)/);
  assert.match(permissions, /camera=\(\)/);
  assert.match(permissions, /microphone=\(\)/);
  assert.match(permissions, /publickey-credentials-get=\(self\)/);
};

test('production defaults to the single trusted Nginx proxy hop', () => {
  const originalProxyHops = process.env.TRUST_PROXY_HOPS;
  delete process.env.TRUST_PROXY_HOPS;
  try {
    const app = createApp({
      environment: 'production',
      listenerDistPath: path.join(os.tmpdir(), 'archtree-listener-proxy-setting-missing')
    });
    assert.equal(app.get('trust proxy'), 1);
  } finally {
    if (originalProxyHops === undefined) delete process.env.TRUST_PROXY_HOPS;
    else process.env.TRUST_PROXY_HOPS = originalProxyHops;
  }
});

test('listener routes report a clear service error when the bundle is absent', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'archtree-listener-missing-'));
  const { server, baseUrl } = await listen(path.join(temporaryRoot, 'missing-dist'));
  try {
    const response = await fetch(`${baseUrl}/listen/library`);
    assert.equal(response.status, 503);
    assertSecurityHeaders(response);
    assert.match((await response.json()).message, /Build web\/dist/);
    assert.equal(response.headers.get('cache-control'), 'no-store');

    const authResponse = await fetch(`${baseUrl}/auth/capabilities`);
    assert.equal(authResponse.status, 200);
    assertSecurityHeaders(authResponse);
    assert.equal((await authResponse.json()).password, true);

    const loginPage = await fetch(`${baseUrl}/auth/login-web`);
    assert.equal(loginPage.status, 200);
    assertSecurityHeaders(loginPage, { inlineStyles: true });
    assert.match(await loginPage.text(), /Log in to Archtree/);

    const contentManagerRedirect = await fetch(`${baseUrl}/content/manage`, {
      redirect: 'manual'
    });
    assert.equal(contentManagerRedirect.status, 302);
    assertSecurityHeaders(contentManagerRedirect, { inlineStyles: true });

    const serverRenderedStyles = await fetch(`${baseUrl}/assets/archtree.css`);
    assert.equal(serverRenderedStyles.status, 200);
    assertSecurityHeaders(serverRenderedStyles);
    assert.match(serverRenderedStyles.headers.get('content-type') ?? '', /text\/css/);
  } finally {
    await close(server);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('listener caches only manifested assets and reserves SPA fallbacks for routes', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'archtree-listener-built-'));
  const distPath = path.join(temporaryRoot, 'dist');
  await mkdir(path.join(distPath, 'assets'), { recursive: true });
  await mkdir(path.join(distPath, '.vite'), { recursive: true });
  await writeFile(path.join(distPath, 'index.html'), '<!doctype html><main>listener-shell</main>');
  await writeFile(path.join(distPath, 'assets', 'app-1234abcd.js'), 'globalThis.listenerLoaded = true;');
  await writeFile(path.join(distPath, 'assets', 'theme-87654321.css'), 'body { color: white; }');
  await writeFile(path.join(distPath, 'assets', 'player-controls.js'), 'globalThis.controlsLoaded = true;');
  await writeFile(path.join(distPath, 'assets', 'runtime.js'), 'globalThis.runtimeLoaded = true;');
  await writeFile(path.join(distPath, '.vite', 'manifest.json'), JSON.stringify({
    'index.html': {
      file: 'assets/app-1234abcd.js',
      css: ['assets/theme-87654321.css'],
      isEntry: true
    }
  }));

  const { server, baseUrl } = await listen(distPath);
  try {
    for (const pathname of ['/listen', '/listen/albums/example']) {
      const response = await fetch(`${baseUrl}${pathname}`);
      assert.equal(response.status, 200);
      assertSecurityHeaders(response);
      assert.match(await response.text(), /listener-shell/);
      assert.equal(response.headers.get('cache-control'), 'no-cache');
    }

    const hashedAsset = await fetch(`${baseUrl}/listen/assets/app-1234abcd.js`);
    assert.equal(hashedAsset.status, 200);
    assertSecurityHeaders(hashedAsset);
    assert.equal(
      hashedAsset.headers.get('cache-control'),
      'public, max-age=31536000, immutable'
    );

    const manifestedStylesheet = await fetch(`${baseUrl}/listen/assets/theme-87654321.css`);
    assert.equal(manifestedStylesheet.status, 200);
    assertSecurityHeaders(manifestedStylesheet);
    assert.equal(
      manifestedStylesheet.headers.get('cache-control'),
      'public, max-age=31536000, immutable'
    );

    for (const filename of ['player-controls.js', 'runtime.js']) {
      const unmanifestedAsset = await fetch(`${baseUrl}/listen/assets/${filename}`);
      assert.equal(unmanifestedAsset.status, 200);
      assert.doesNotMatch(unmanifestedAsset.headers.get('cache-control') ?? '', /immutable/);
    }

    for (const pathname of ['/listen/assets/missing-deadbeef.js', '/listen/missing.css']) {
      const missingAsset = await fetch(`${baseUrl}${pathname}`);
      assert.equal(missingAsset.status, 404);
      assert.equal(missingAsset.headers.get('cache-control'), 'no-store');
      assert.doesNotMatch(await missingAsset.text(), /listener-shell/);
    }

    const listenerApi = await fetch(`${baseUrl}/api/listener/v1/search`);
    assert.equal(listenerApi.status, 400);
    assertSecurityHeaders(listenerApi);
  } finally {
    await close(server);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
