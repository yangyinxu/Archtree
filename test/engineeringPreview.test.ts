import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

/** A malformed request must fail individually rather than terminating the local preview. */
test('engineering preview survives malformed request targets and serves only its allowlist', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'engineering-preview-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const distPath = path.join(root, 'dist');
  await mkdir(distPath);
  const pages = [
    { slug: '', title: 'Guide', lang: 'en-US' },
    { slug: 'zh-hans', title: '工程指南', lang: 'zh-Hans' },
    { slug: 'zh-hans/start', title: '开始使用', lang: 'zh-Hans' },
    { slug: 'zh-hans/flows/read-album', title: '读取专辑', lang: 'zh-Hans' }
  ];
  await writeFile(path.join(distPath, 'manifest.json'), JSON.stringify({
    schemaVersion: 1, pages: pages.map(page => ({ slug: page.slug, file: page.slug ? `${page.slug}/index.html` : 'index.html' }))
  }));
  for (const page of pages) {
    const directory = path.join(distPath, page.slug);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'index.html'), `<!doctype html><html lang="${page.lang}"><title>Local guide</title><h1>${page.title}</h1></html>`);
  }
  await writeFile(path.join(distPath, 'guide.css'), 'body { color: black; }');
  await writeFile(path.join(distPath, 'guide.js'), '/* local guide */');
  const moduleUrl = new URL('../scripts/preview-engineering.mjs', import.meta.url);
  const { startEngineeringPreview } = await import(moduleUrl.href);
  const { server, url } = await startEngineeringPreview({ port: 0, distPath });
  t.after(() => new Promise<void>((resolve, reject) => server.close((error: Error | undefined) => error ? reject(error) : resolve())));
  const origin = new URL(url);
  const rawRequest = (target: string) => new Promise<number>((resolve, reject) => {
    const req = request({ hostname: origin.hostname, port: origin.port, path: target }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode!));
    });
    req.on('error', reject);
    req.end();
  });
  for (const target of ['//[', '//%', 'http://[']) assert.equal(await rawRequest(target), 400);
  for (const page of pages) {
    const pageUrl = `${url}${page.slug ? `/${page.slug}` : ''}`;
    const response = await fetch(pageUrl);
    assert.equal(response.status, 200);
    assert.match(await response.text(), new RegExp(`<html lang="${page.lang}">.*<h1>${page.title}</h1>`));
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
    const head = await fetch(pageUrl, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    const trailingSlash = await fetch(`${pageUrl}/`, { redirect: 'manual' });
    assert.equal(trailingSlash.status, 302);
    assert.equal(trailingSlash.headers.get('location'), new URL(pageUrl).pathname);
  }
  for (const asset of ['guide.css', 'guide.js']) {
    assert.equal((await fetch(`${url}/${asset}`)).status, 200);
    assert.equal((await fetch(`${url}/zh-hans/${asset}`)).status, 404);
  }
  assert.equal((await fetch(`${url}/manifest.json`)).status, 404);
  assert.equal((await fetch(`${url}/zh-hans/manifest.json`)).status, 404);
  assert.equal((await fetch(`${url}/zh-Hans`)).status, 404);
  assert.equal((await fetch(url, { method: 'POST' })).status, 405);
  await rm(path.join(distPath, 'zh-hans/flows/read-album/index.html'));
  await assert.rejects(startEngineeringPreview({ port: 0, distPath }), { code: 'ENOENT' });
});
