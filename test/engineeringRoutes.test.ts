import assert from 'node:assert/strict';
import { request, Server } from 'node:http';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { TestContext } from 'node:test';
import jwt from 'jsonwebtoken';

import { createApp, renderLandingActions } from '../src/app';
import { safeWebReturnTo } from '../src/controllers/authController';
import AuthSession from '../src/models/authSession';
import User from '../src/models/user';

const jwtSecret = 'engineering-routes-unit-test-secret';
const adminUserId = '64b000000000000000000001';
const ordinaryUserId = '64b000000000000000000002';
const revokedUserId = '64b000000000000000000003';
const guideHtml = '<!doctype html><html><body><h1>Engineering Guide fixture</h1></body></html>';
const flowHtml = '<!doctype html><html><body><h1>Album request walkthrough</h1></body></html>';
const translatedPages = [
  { slug: 'zh-hans', title: '工程指南', description: '从这里开始。' },
  { slug: 'zh-hans/start', title: '开始使用', description: '准备开发环境。' },
  { slug: 'zh-hans/flows/read-album', title: '读取专辑', description: '跟踪专辑请求。' }
];
const translatedHtml = (title: string) => `<!doctype html><html lang="zh-Hans"><body><h1>${title}</h1></body></html>`;
const manifest = () => ({
  schemaVersion: 1,
  revision: { commit: 'a'.repeat(40), dirty: false },
  sourceDigest: 'b'.repeat(64),
  pages: [
    { slug: '', title: 'Engineering Guide', description: 'Start here.', file: 'index.html' },
    { slug: 'flows/album', title: 'Album request', description: 'Trace a request.', file: 'flows/album/index.html' },
    ...translatedPages.map(page => ({ ...page, file: `${page.slug}/index.html` }))
  ],
  assets: ['guide.css', 'guide.js']
});

/** The HTTP tests exercise real JWT/session/role middleware with only database reads stubbed. */
const authorize = (t: TestContext, ordinaryRole: unknown = 'user') => {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = jwtSecret;
  t.after(() => {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  });
  t.mock.method(AuthSession, 'findActiveById', async (sessionId: string) => {
    const userId = sessionId === adminUserId ? adminUserId : sessionId === ordinaryUserId ? ordinaryUserId : null;
    return userId ? { userId } : null;
  });
  t.mock.method(User, 'findById', async (userId: string) => ({
    email: `${userId}@example.test`,
    role: userId === adminUserId ? 'admin' : ordinaryRole
  }));
};

const cookie = (userId: string) => `session_token=${jwt.sign({
  userId,
  email: `${userId}@example.test`,
  // A claimed admin token must not override the authoritative persisted user role.
  role: 'admin',
  sessionId: userId,
  tokenType: 'access'
}, jwtSecret, { algorithm: 'HS256', expiresIn: 60 })}`;

const createFixture = async (t: TestContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'archtree-engineering-routes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const engineeringDistPath = path.join(root, 'engineering');
  const listenerDistPath = path.join(root, 'listener');
  await mkdir(path.join(engineeringDistPath, 'flows', 'album'), { recursive: true });
  for (const page of translatedPages) await mkdir(path.join(engineeringDistPath, page.slug), { recursive: true });
  await mkdir(listenerDistPath);
  await Promise.all([
    writeFile(path.join(engineeringDistPath, 'manifest.json'), JSON.stringify(manifest())),
    writeFile(path.join(engineeringDistPath, 'index.html'), guideHtml),
    writeFile(path.join(engineeringDistPath, 'flows', 'album', 'index.html'), flowHtml),
    ...translatedPages.map(page => writeFile(path.join(engineeringDistPath, page.slug, 'index.html'), translatedHtml(page.title))),
    writeFile(path.join(engineeringDistPath, 'guide.css'), 'body { color: navy; }'),
    writeFile(path.join(engineeringDistPath, 'guide.js'), 'document.documentElement.dataset.guide = "ready";'),
    writeFile(path.join(engineeringDistPath, 'private.txt'), 'must-never-be-served'),
    writeFile(path.join(root, 'outside.txt'), 'outside-bundle-must-never-be-served'),
    writeFile(path.join(listenerDistPath, 'index.html'), '<h1>Finitude listener fixture</h1>')
  ]);
  return { root, engineeringDistPath, listenerDistPath };
};

const listen = async (t: TestContext, options: Parameters<typeof createApp>[0]) => {
  const server = await new Promise<Server>((resolve) => {
    const listening = createApp({ ...options, environment: 'test' }).listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
};

const assertPrivate = (response: Response) => {
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.match(response.headers.get('vary') ?? '', /Cookie/);
  assert.match(response.headers.get('vary') ?? '', /Authorization/);
};

test('engineering pages, assets and unknown paths authenticate before revealing any bundle state', async (t) => {
  authorize(t);
  const fixture = await createFixture(t);
  const baseUrl = await listen(t, fixture);
  for (const pathname of ['/engineering', '/engineering/flows/album?view=trace', '/engineering/zh-hans', '/engineering/zh-hans/start', '/engineering/zh-hans/flows/read-album?view=trace', '/engineering/guide.css', '/engineering/guide.js', '/engineering/manifest.json', '/engineering/unknown']) {
    for (const headers of [{}, { cookie: 'session_token=invalid' }, { cookie: cookie(revokedUserId) }]) {
      const response = await fetch(`${baseUrl}${pathname}`, { redirect: 'manual', headers });
      assert.equal(response.status, 302);
      assert.equal(response.headers.get('location'), `/auth/login-web?returnTo=${encodeURIComponent(pathname)}`);
      assertPrivate(response);
      assert.doesNotMatch(await response.text(), /Engineering Guide fixture|body \{ color|must-never/);
    }
  }
});

test('engineering authorization uses the persisted admin role and denies ordinary or legacy accounts', async (t) => {
  const fixture = await createFixture(t);
  const baseUrl = await listen(t, fixture);
  for (const role of ['user', 'creator', 'ADMIN', undefined]) {
    await t.test(`denies ${String(role)}`, async (t) => {
      authorize(t, role);
      for (const pathname of ['/engineering', '/engineering/flows/album', ...translatedPages.map(page => `/engineering/${page.slug}`), '/engineering/guide.css', '/engineering/guide.js']) {
        const response = await fetch(`${baseUrl}${pathname}`, { headers: { cookie: cookie(ordinaryUserId) } });
        assert.equal(response.status, 403);
        assert.equal(await response.text(), 'Administrator access is required.');
        assertPrivate(response);
      }
    });
  }
});

test('admins can open and reload exact guide pages and assets independently of Finitude', async (t) => {
  authorize(t);
  const fixture = await createFixture(t);
  const baseUrl = await listen(t, fixture);
  const headers = { cookie: cookie(adminUserId) };
  for (const [pathname, expected, contentType] of [
    ['/engineering', guideHtml, 'text/html'],
    ['/engineering/flows/album?view=trace', flowHtml, 'text/html'],
    ...translatedPages.map(page => [`/engineering/${page.slug}`, translatedHtml(page.title), 'text/html']),
    ['/engineering/guide.css?version=1', 'body { color: navy; }', 'text/css'],
    ['/engineering/guide.js', 'document.documentElement.dataset.guide = "ready";', 'text/javascript']
  ]) {
    const response = await fetch(`${baseUrl}${pathname}`, { headers });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), expected);
    assert.match(response.headers.get('content-type') ?? '', new RegExp(contentType));
    assertPrivate(response);
    assert.equal(response.headers.getSetCookie().length, 0);
    assert.doesNotMatch(response.headers.get('content-security-policy') ?? '', /unsafe-inline/);
    const head = await fetch(`${baseUrl}${pathname}`, { method: 'HEAD', headers });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    assertPrivate(head);
  }

  for (const pathname of ['/engineering/', '/engineering/flows/album/?view=trace', '/engineering/zh-hans/', '/engineering/zh-hans/start/', '/engineering/zh-hans/flows/read-album/?view=trace']) {
    const response = await fetch(`${baseUrl}${pathname}`, { redirect: 'manual', headers });
    assert.equal(response.status, 308);
    assert.equal(response.headers.get('location'), pathname.replace(/\/(?=\?|$)/, ''));
    assertPrivate(response);
  }
  const listener = await fetch(`${baseUrl}/finitude/engineering`);
  assert.equal(listener.status, 200);
  assert.equal(await listener.text(), '<h1>Finitude listener fixture</h1>');
  const legacy = await fetch(`${baseUrl}/listen/library`, { redirect: 'manual' });
  assert.equal(legacy.headers.get('location'), '/finitude/library');
});

test('unknown guide paths and raw traversal cannot expose manifests, source files or SPA fallbacks', async (t) => {
  authorize(t);
  const fixture = await createFixture(t);
  const baseUrl = await listen(t, fixture);
  for (const pathname of [
    '/engineering/unknown', '/engineering/flows', '/engineering/index.html',
    '/engineering/flows/album/index.html', '/engineering/manifest.json',
    '/engineering/zh-hans/guide.css', '/engineering/zh-hans/guide.js',
    '/engineering/zh-Hans', '/engineering/zh-hans/manifest.json',
    '/engineering/zh-hans/flows/read-album/index.html',
    '/engineering/private.txt', '/engineering/guide.css/', '/engineering//',
    '/engineering/../outside.txt', '/engineering/%2e%2e/outside.txt',
    '/engineering/flows%2falbum', '/engineering/%252e%252e/outside.txt',
    '/engineering/%00', '/engineering/%', '/engineering/..%5coutside.txt'
  ]) {
    // node:http retains dot segments that fetch would normalize before sending.
    const response = await new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
      const req = request(baseUrl, { path: pathname, headers: { cookie: cookie(adminUserId) } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(response.status, 404, pathname);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.doesNotMatch(response.body, /must-never|fixture|sourceDigest|schemaVersion/);
  }
});

test('the entire guide is read-only and rejects bodies before general JSON parsing', async (t) => {
  authorize(t);
  const fixture = await createFixture(t);
  const baseUrl = await listen(t, fixture);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    const response = await fetch(`${baseUrl}/engineering/flows/album`, {
      method,
      headers: { cookie: cookie(adminUserId), 'content-type': 'application/json' },
      body: '{invalid json'
    });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET, HEAD');
    assertPrivate(response);
  }
});

test('missing, incomplete or oversized guide builds return 503 only after administrator authorization', async (t) => {
  authorize(t);
  const fixture = await createFixture(t);
  for (const mode of ['missing-directory', 'missing-page', 'missing-translated-page', 'missing-asset', 'empty-page', 'empty-asset', 'outside-symlink', 'invalid-json', 'oversized-manifest', 'oversized-page']) {
    await t.test(mode, async (t) => {
      const ownFixture = await createFixture(t);
      if (mode === 'missing-page') await rm(path.join(ownFixture.engineeringDistPath, 'flows/album/index.html'));
      if (mode === 'missing-translated-page') await rm(path.join(ownFixture.engineeringDistPath, 'zh-hans/flows/read-album/index.html'));
      if (mode === 'missing-asset') await rm(path.join(ownFixture.engineeringDistPath, 'guide.js'));
      if (mode === 'empty-page') await writeFile(path.join(ownFixture.engineeringDistPath, 'index.html'), '');
      if (mode === 'empty-asset') await writeFile(path.join(ownFixture.engineeringDistPath, 'guide.js'), '');
      if (mode === 'outside-symlink') {
        await rm(path.join(ownFixture.engineeringDistPath, 'guide.css'));
        await symlink(path.join(ownFixture.root, 'outside.txt'), path.join(ownFixture.engineeringDistPath, 'guide.css'));
      }
      if (mode === 'invalid-json') await writeFile(path.join(ownFixture.engineeringDistPath, 'manifest.json'), '{invalid');
      if (mode === 'oversized-manifest') await writeFile(path.join(ownFixture.engineeringDistPath, 'manifest.json'), ' '.repeat(512 * 1024 + 1));
      if (mode === 'oversized-page') await writeFile(path.join(ownFixture.engineeringDistPath, 'index.html'), 'x'.repeat(2 * 1024 * 1024 + 1));
      const baseUrl = await listen(t, {
        ...ownFixture,
        engineeringDistPath: mode === 'missing-directory' ? path.join(fixture.root, 'missing') : ownFixture.engineeringDistPath
      });
      for (const pathname of ['/engineering', '/engineering/zh-hans/flows/read-album', '/engineering/guide.css']) {
        const anonymous = await fetch(`${baseUrl}${pathname}`, { redirect: 'manual' });
        assert.equal(anonymous.status, 302);
        assertPrivate(anonymous);
        const ordinary = await fetch(`${baseUrl}${pathname}`, { headers: { cookie: cookie(ordinaryUserId) } });
        assert.equal(ordinary.status, 403);
        assertPrivate(ordinary);
        const admin = await fetch(`${baseUrl}${pathname}`, { headers: { cookie: cookie(adminUserId) } });
        assert.equal(admin.status, 503);
        assert.match(await admin.text(), /Build engineering\/dist/);
        assertPrivate(admin);
      }
    });
  }
});

test('malformed or unsafe manifests fail closed as a complete bundle', async (t) => {
  authorize(t);
  const valid = manifest();
  const invalidManifests: unknown[] = [
    null, [], {}, { ...valid, schemaVersion: 2 },
    { ...valid, revision: { commit: '../private', dirty: false } },
    { ...valid, revision: { commit: 'a'.repeat(40), dirty: 'false' } },
    { ...valid, sourceDigest: 'not-a-digest' },
    { ...valid, assets: ['guide.css', '../private.txt'] },
    { ...valid, assets: ['guide.css', 'guide.js', 'private.txt'] },
    { ...valid, pages: [valid.pages[1]] },
    { ...valid, pages: [valid.pages[0], valid.pages[0]] },
    { ...valid, pages: [{ ...valid.pages[0], file: '../outside.txt' }] },
    { ...valid, pages: [valid.pages[0], { ...valid.pages[1], slug: 'flows/../private' }] },
    { ...valid, pages: [valid.pages[0], { ...valid.pages[1], title: '' }] }
  ];
  for (const [index, candidate] of invalidManifests.entries()) {
    await t.test(`invalid manifest ${index}`, async (t) => {
      const fixture = await createFixture(t);
      await writeFile(path.join(fixture.engineeringDistPath, 'manifest.json'), JSON.stringify(candidate));
      const baseUrl = await listen(t, fixture);
      const response = await fetch(`${baseUrl}/engineering`, { headers: { cookie: cookie(adminUserId) } });
      assert.equal(response.status, 503);
      assertPrivate(response);
    });
  }
});

test('login preserves safe engineering deep links while rejecting external URLs and dot traversal', async (t) => {
  authorize(t);
  const fixture = await createFixture(t);
  const baseUrl = await listen(t, fixture);
  for (const destination of ['/engineering', '/engineering/flows/album?view=trace#authorization', '/engineering/zh-hans', '/engineering/zh-hans/start', '/engineering/zh-hans/flows/read-album?view=trace#authorization']) {
    assert.equal(safeWebReturnTo(destination), destination);
    const login = await fetch(`${baseUrl}/auth/login-web?returnTo=${encodeURIComponent(destination)}`);
    assert.equal(login.status, 200);
    assert.match(await login.text(), new RegExp(`name="returnTo" value="${destination.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
    const signedIn = await fetch(`${baseUrl}/auth/login-web?returnTo=${encodeURIComponent(destination)}`, {
      redirect: 'manual', headers: { cookie: cookie(adminUserId) }
    });
    assert.equal(signedIn.status, 303);
    assert.equal(signedIn.headers.get('location'), destination);
  }
  for (const destination of [
    'https://attacker.example/engineering', '//attacker.example/engineering',
    '/\\attacker.example/engineering', '/engineering/../finitude',
    '/engineering/%2e%2e/finitude', '/engineering/.',
    '/engineering/%252e%252e/private', '/engineering//attacker.example',
    '/engineering-other', '/engineering/manifest.json', '/engineering/flows%2falbum',
    '/engineering/zh-hans/%2e%2e/start', '/engineering/zh-hans/guide.css',
    '/engineering/%', '/engineering\n/flows'
  ]) assert.equal(safeWebReturnTo(destination), '/', destination);
});

test('only administrators see the Engineering Guide landing action', () => {
  for (const role of [undefined, 'user', 'creator', 'ADMIN']) {
    const actions = role === undefined ? renderLandingActions() : renderLandingActions({ userId: ordinaryUserId, email: 'user@example.test', role });
    assert.doesNotMatch(`${actions.headerActions}${actions.heroActions}`, /href="\/engineering"/);
  }
  const admin = renderLandingActions({ userId: adminUserId, email: 'admin@example.test', role: 'admin' });
  assert.match(admin.heroActions, /href="\/engineering"[^>]*>.*Engineering Guide/);
});
