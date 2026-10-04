import { createServer } from 'node:http';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultDistPath = fileURLToPath(new URL('../engineering/dist', import.meta.url));
const prefix = '/engineering';
const allowedSlug = /^(?:[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*){0,3})?$/;

/** Serves only the generated guide on loopback; no application credentials or database are loaded. */
export const startEngineeringPreview = async ({ port = 4174, distPath = defaultDistPath } = {}) => {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('The preview port must be a valid TCP port.');
  const root = await realpath(distPath);
  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.pages) || !manifest.pages.length) {
    throw new Error('Build the engineering guide before starting its preview.');
  }
  const files = new Map();
  const load = async (url, file, contentType) => {
    const resolved = path.join(root, file);
    if (!(await lstat(resolved)).isFile() || await realpath(resolved) !== resolved) throw new Error('Preview files must be regular generated files.');
    files.set(url, { body: await readFile(resolved), contentType });
  };
  for (const page of manifest.pages) {
    if (typeof page.slug !== 'string' || page.slug.length > 160 || !allowedSlug.test(page.slug)) throw new Error('Invalid guide page.');
    const expectedFile = page.slug ? `${page.slug}/index.html` : 'index.html';
    if (page.file !== expectedFile) throw new Error('Invalid guide page file.');
    await load(`${prefix}${page.slug ? `/${page.slug}` : ''}`, expectedFile, 'text/html; charset=utf-8');
  }
  await load(`${prefix}/guide.css`, 'guide.css', 'text/css; charset=utf-8');
  await load(`${prefix}/guide.js`, 'guide.js', 'text/javascript; charset=utf-8');
  const server = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    if (!['GET', 'HEAD'].includes(req.method || '')) {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    let pathname;
    try {
      const target = req.url || '/';
      if (!target.startsWith('/') || target.startsWith('//')) throw new Error('Invalid request target.');
      pathname = new URL(target, 'http://127.0.0.1').pathname;
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Invalid preview request.');
      return;
    }
    if (pathname === '/' || pathname === `${prefix}/` || pathname.endsWith('/') && files.has(pathname.slice(0, -1))) {
      res.writeHead(302, { Location: pathname === '/' ? prefix : pathname.slice(0, -1) }).end();
      return;
    }
    const file = files.get(pathname);
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end(req.method === 'HEAD' ? undefined : 'This page is not in the engineering guide.');
      return;
    }
    res.writeHead(200, { 'Content-Type': file.contentType, 'Content-Length': file.body.length });
    res.end(req.method === 'HEAD' ? undefined : file.body);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  return { server, url: `http://127.0.0.1:${address.port}${prefix}` };
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  startEngineeringPreview().then(({ server, url }) => {
    console.log(`Engineering guide preview: ${url}`);
    console.log('Local documentation only. Rebuild and restart to see changes. Press Ctrl+C to stop.');
    const close = () => server.close();
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
  }).catch(error => {
    console.error(`Engineering preview could not start: ${error.code === 'ENOENT' ? 'Run npm run build:engineering first.' : error.message}`);
    process.exitCode = 1;
  });
}
