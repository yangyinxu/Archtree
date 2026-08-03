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

const telemetryEvent = {
  category: 'web_vital',
  route: 'home',
  metric: 'LCP',
  value: 1_250,
  navigationType: 'navigate'
};

const telemetryHeaders = (baseUrl: string, client = '198.51.100.10') => ({
  'Content-Type': 'application/json',
  'Origin': baseUrl,
  'X-Forwarded-For': client
});

test('listener telemetry accepts strict same-origin batches without requiring credentials', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'archtree-listener-telemetry-'));
  const { server, baseUrl } = await listen(path.join(temporaryRoot, 'missing-dist'));
  const originalInfo = console.info;
  const records: string[] = [];
  console.info = (value?: unknown) => { records.push(String(value)); };
  try {
    const anonymous = await fetch(`${baseUrl}/api/listener/v1/telemetry`, {
      method: 'POST',
      headers: telemetryHeaders(baseUrl),
      body: JSON.stringify({ events: [telemetryEvent] })
    });
    assert.equal(anonymous.status, 204);
    assertSecurityHeaders(anonymous);
    assert.equal(anonymous.headers.get('cache-control'), 'no-store');
    assert.equal(anonymous.headers.get('pragma'), 'no-cache');
    assert.equal(await anonymous.text(), '');

    const withIrrelevantCookie = await fetch(`${baseUrl}/api/listener/v1/telemetry`, {
      method: 'POST',
      headers: {
        ...telemetryHeaders(baseUrl, '198.51.100.11'),
        Cookie: 'session_token=not-a-valid-credential'
      },
      body: JSON.stringify({ events: [{
        category: 'playback_error',
        route: 'album',
        stage: 'play_call',
        code: 'network'
      }] })
    });
    assert.equal(withIrrelevantCookie.status, 204);
    assert.equal(records.length, 2);
    for (const record of records) {
      assert.doesNotMatch(record, /session_token|not-a-valid-credential|198\.51\.100/);
      const parsed = JSON.parse(record);
      assert.equal(parsed.schemaVersion, 1);
      assert.equal(typeof parsed.occurredAt, 'string');
    }
  } finally {
    console.info = originalInfo;
    await close(server);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('listener telemetry rejects cross-origin, non-JSON, unbounded, and oversized input', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'archtree-listener-telemetry-invalid-'));
  const { server, baseUrl } = await listen(path.join(temporaryRoot, 'missing-dist'));
  try {
    const crossOrigin = await fetch(`${baseUrl}/api/listener/v1/telemetry`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://attacker.example',
        'X-Forwarded-For': '198.51.100.20'
      },
      body: JSON.stringify({ events: [telemetryEvent] })
    });
    assert.equal(crossOrigin.status, 403);
    assert.equal(crossOrigin.headers.get('cache-control'), 'no-store');

    const nonJson = await fetch(`${baseUrl}/api/listener/v1/telemetry`, {
      method: 'POST',
      headers: {
        Origin: baseUrl,
        'Content-Type': 'text/plain',
        'X-Forwarded-For': '198.51.100.21'
      },
      body: 'not-json'
    });
    assert.equal(nonJson.status, 415);

    const originless = await fetch(`${baseUrl}/api/listener/v1/telemetry`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': '198.51.100.25'
      },
      body: JSON.stringify({ events: [telemetryEvent] })
    });
    assert.equal(originless.status, 403);

    const malformed = await fetch(`${baseUrl}/api/listener/v1/telemetry`, {
      method: 'POST',
      headers: telemetryHeaders(baseUrl, '198.51.100.26'),
      body: '{"events":[private-secret]}'
    });
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { message: 'Invalid JSON request.' });

    const rawField = await fetch(`${baseUrl}/api/listener/v1/telemetry`, {
      method: 'POST',
      headers: telemetryHeaders(baseUrl, '198.51.100.22'),
      body: JSON.stringify({ events: [{
        ...telemetryEvent,
        url: '/listen/search?q=private'
      }] })
    });
    assert.equal(rawField.status, 422);
    assert.deepEqual(await rawField.json(), {
      message: 'Invalid listener telemetry payload.'
    });

    const authenticationFunnel = await fetch(`${baseUrl}/api/listener/v1/telemetry`, {
      method: 'POST',
      headers: telemetryHeaders(baseUrl, '198.51.100.23'),
      body: JSON.stringify({ events: [{
        category: 'authentication_funnel',
        stage: 'login',
        method: 'password',
        outcome: 'rejected'
      }] })
    });
    assert.equal(authenticationFunnel.status, 422);

    const oversized = await fetch(`${baseUrl}/api/listener/v1/telemetry`, {
      method: 'POST',
      headers: telemetryHeaders(baseUrl, '198.51.100.24'),
      body: JSON.stringify({ events: [{
        ...telemetryEvent,
        padding: 'x'.repeat(17 * 1024)
      }] })
    });
    assert.equal(oversized.status, 413);
    assert.equal(oversized.headers.get('cache-control'), 'no-store');
  } finally {
    await close(server);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('listener telemetry limits every client to twenty batches per minute', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'archtree-listener-telemetry-rate-'));
  const { server, baseUrl } = await listen(path.join(temporaryRoot, 'missing-dist'));
  const headers = telemetryHeaders(baseUrl, '198.51.100.30');
  try {
    for (let request = 1; request <= 20; request += 1) {
      const response = await fetch(`${baseUrl}/api/listener/v1/telemetry`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ events: [] })
      });
      assert.equal(response.status, 422);
      assert.equal(response.headers.get('ratelimit-limit'), '20');
    }
    const rejected = await fetch(`${baseUrl}/api/listener/v1/telemetry`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ events: [telemetryEvent] })
    });
    assert.equal(rejected.status, 429);
    assert.equal(rejected.headers.get('retry-after') !== null, true);
  } finally {
    await close(server);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('unexpected telemetry sink failures emit only bounded server error fields', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'archtree-listener-telemetry-error-'));
  const { server, baseUrl } = await listen(path.join(temporaryRoot, 'missing-dist'));
  const originalInfo = console.info;
  const originalError = console.error;
  const records: string[] = [];
  console.info = () => {
    throw new Error('listener@example.com /listen/search?q=private access-token');
  };
  console.error = (value?: unknown) => { records.push(String(value)); };
  try {
    const response = await fetch(
      `${baseUrl}/api/listener/v1/telemetry?query=private-content-id`,
      {
        method: 'POST',
        headers: telemetryHeaders(baseUrl, '198.51.100.40'),
        body: JSON.stringify({ events: [telemetryEvent] })
      }
    );
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      message: 'The service could not complete the request.'
    });
    assert.equal(records.length, 1);
    const logged = records[0];
    assert.doesNotMatch(logged, /listener@example|private|content-id|access-token|198\.51\.100/);
    assert.deepEqual(
      Object.keys(JSON.parse(logged)).sort(),
      ['category', 'method', 'occurredAt', 'requestArea', 'status'].sort()
    );
    assert.deepEqual(
      { ...JSON.parse(logged), occurredAt: '<bounded-server-time>' },
      {
        category: 'server_error',
        requestArea: 'listener_telemetry',
        method: 'POST',
        status: 500,
        occurredAt: '<bounded-server-time>'
      }
    );
  } finally {
    console.info = originalInfo;
    console.error = originalError;
    await close(server);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
