import express, { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';

import { requireAdminForWeb, requireAuthForWeb } from '../middleware/authMiddleware';
import { setBrowserSessionPrivacyHeaders } from '../services/authCookieService';

/** A generated guide page is served only at its reviewed, extensionless slug. */
interface GuidePage {
  slug: string;
  title: string;
  description: string;
  file: string;
}

/** The build manifest is an allowlist, never a public file browsing endpoint. */
interface GuideManifest {
  schemaVersion: 1;
  revision: { commit: string; dirty: boolean };
  sourceDigest: string;
  pages: GuidePage[];
  assets: string[];
}

/** Serves bytes from one validated build without reopening filesystem paths per request. */
interface GuideResource {
  bytes: Buffer;
  contentType: string;
  page: boolean;
}

const fixedAssets = ['guide.css', 'guide.js'];
const maxManifestBytes = 512 * 1024;
const maxFileBytes = 2 * 1024 * 1024;
const maxBundleBytes = 16 * 1024 * 1024;
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*){0,3}$/;

/** Rejects unexpected manifest types before they can influence filesystem reads. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Validates paths by derivation instead of trusting filenames from the manifest. */
const parseManifest = (value: unknown): GuideManifest => {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || !isRecord(value.revision)
    || typeof value.revision.commit !== 'string'
    || !/^(?:[a-f0-9]{40}|unknown)$/.test(value.revision.commit)
    || typeof value.revision.dirty !== 'boolean'
    || typeof value.sourceDigest !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.sourceDigest)
    || !Array.isArray(value.pages)
    || value.pages.length === 0
    || value.pages.length > 200
    || !Array.isArray(value.assets)
    || value.assets.length !== fixedAssets.length) {
    throw new Error('Invalid engineering manifest.');
  }
  if (new Set(value.assets).size !== fixedAssets.length
    || value.assets.some((asset) => !fixedAssets.includes(asset))) {
    throw new Error('Invalid engineering assets.');
  }

  const slugs = new Set<string>();
  for (const page of value.pages) {
    if (!isRecord(page)
      || typeof page.slug !== 'string'
      || page.slug.length > 160
      || (page.slug !== '' && !slugPattern.test(page.slug))
      || slugs.has(page.slug)
      || typeof page.title !== 'string' || !page.title.trim() || page.title.length > 200
      || typeof page.description !== 'string' || !page.description.trim() || page.description.length > 1000
      || page.file !== (page.slug ? `${page.slug}/index.html` : 'index.html')) {
      throw new Error('Invalid engineering page.');
    }
    slugs.add(page.slug);
  }
  if (!slugs.has('')) throw new Error('Missing engineering home page.');
  return value as unknown as GuideManifest;
};

/** Reads only bounded regular files whose real locations remain inside the bundle. */
const readBundleFile = (root: string, filename: string, limit: number) => {
  const file = path.join(root, filename);
  const resolved = fs.realpathSync(file);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error('Engineering file is outside the bundle.');
  }
  const stat = fs.statSync(resolved);
  if (!stat.isFile() || stat.size === 0 || stat.size > limit) throw new Error('Invalid engineering file size.');
  const bytes = fs.readFileSync(resolved);
  if (bytes.length === 0 || bytes.length > limit) throw new Error('Invalid engineering file size.');
  return bytes;
};

/** Loads a complete, immutable snapshot so failed builds never produce partial guides. */
const readBundle = (distPath: string): Map<string, GuideResource> | null => {
  try {
    const root = fs.realpathSync(distPath);
    const manifest = parseManifest(JSON.parse(readBundleFile(root, 'manifest.json', maxManifestBytes).toString('utf8')));
    const resources = new Map<string, GuideResource>();
    let totalBytes = 0;
    const add = (route: string, file: string, contentType: string, page: boolean) => {
      const bytes = readBundleFile(root, file, maxFileBytes);
      totalBytes += bytes.length;
      if (totalBytes > maxBundleBytes) throw new Error('Engineering bundle is too large.');
      resources.set(route, { bytes, contentType, page });
    };
    for (const page of manifest.pages) {
      add(page.slug ? `/${page.slug}` : '/', page.file, 'text/html; charset=utf-8', true);
    }
    add('/guide.css', 'guide.css', 'text/css; charset=utf-8', false);
    add('/guide.js', 'guide.js', 'text/javascript; charset=utf-8', false);
    return resources;
  } catch {
    // A missing, partial, or malformed build fails closed without exposing paths.
    return null;
  }
};

/** Serves the independent engineering guide under the existing administrator boundary. */
export const createEngineeringRouter = (
  distPath = path.resolve(__dirname, '..', '..', 'engineering', 'dist')
): Router => {
  const router = express.Router();
  const resources = readBundle(distPath);

  router.use((_req, res, next) => {
    setBrowserSessionPrivacyHeaders(res);
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.vary('Cookie');
    res.vary('Authorization');
    next();
  });
  router.use(requireAuthForWeb, requireAdminForWeb);
  router.use((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      return res.status(405).type('text/plain').send('The engineering guide is read-only.');
    }
    if (!resources) {
      return res.status(503).type('text/plain').send(
        'The Engineering Guide bundle is unavailable. Build engineering/dist and restart the server.'
      );
    }

    const requestPath = req.path;
    const originalPath = req.originalUrl.split('?', 1)[0];
    const canonicalPath = requestPath === '/' ? '/' : requestPath.replace(/\/$/, '');
    const resource = originalPath.includes('//') ? undefined : resources.get(canonicalPath);
    if (!resource || (!resource.page && requestPath !== canonicalPath)) {
      return res.status(404).type('text/plain').send('The requested engineering page or asset was not found.');
    }
    if (resource.page && originalPath.endsWith('/')) {
      const query = req.originalUrl.slice(originalPath.length);
      return res.redirect(308, `${req.baseUrl}${canonicalPath === '/' ? '' : canonicalPath}${query}`);
    }
    return res.status(200).type(resource.contentType).send(resource.bytes);
  });

  return router;
};
