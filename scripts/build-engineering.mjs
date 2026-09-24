import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { engineeringLocales, localizeEngineeringGuide } from './lib/engineering-localization.mjs';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const slugPattern = /^(?:[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*){0,3})?$/;
const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const assetNames = ['guide.css', 'guide.js'];
const guidePath = 'docs/engineering/guide.json';
const rendererPath = 'scripts/lib/engineering-renderer.mjs';
const localizationPath = 'scripts/lib/engineering-localization.mjs';
const interfacePath = 'engineering/locales/en-US.json';
const translationPath = 'docs/engineering/locales/zh-Hans.json';

/** Rejects unknown fields so authored content cannot silently become executable configuration. */
const record = (value, required, optional, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => ![...required, ...optional].includes(key))) {
    throw new Error(`${label} has an invalid shape or unsupported fields.`);
  }
};
const text = (value, label, maximum = 3000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    throw new Error(`${label} must be nonempty text of at most ${maximum} characters.`);
  }
};
const list = (value, label, maximum, minimum = 1) => {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new Error(`${label} must contain ${minimum}–${maximum} entries.`);
  }
};
const sourcePathAllowed = relative => {
  if (typeof relative !== 'string' || relative.length > 240 || !/^[A-Za-z0-9_.\/-]+$/.test(relative)
    || relative.startsWith('/') || relative.split('/').some(part => !part || part === '.' || part === '..')
    || (relative !== '.env.example' && relative.split('/').some(part => /^\.env(?:\.|$)/i.test(part) || /^(?:credentials|secrets)(?:\.|$)/i.test(part)))) return false;
  return ['README.md', 'AGENTS.md', 'package.json', 'tsconfig.json', '.nvmrc', '.node-version', '.env.example', 'web/package.json', 'web/vite.config.ts', 'web/playwright.config.ts', 'web/scripts/check-initial-js-budget.mjs'].includes(relative)
    || /^docs\/(?!.*(?:^|\/)dist\/).+\.(?:md|json)$/.test(relative)
    || /^(?:src|web\/src)\/.+\.(?:ts|tsx|js|css|json)$/.test(relative)
    || /^scripts\/.+\.(?:mjs|ts|js)$/.test(relative)
    || /^(?:test|contracts|localization)\/.+\.(?:ts|json|mjs)$/.test(relative)
    || /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(relative);
};

/** Validates bounded authored content and returns only explicit source references. */
export const validateEngineeringGuide = (guide, scripts) => {
  record(guide, ['schemaVersion', 'pages'], [], 'Engineering guide');
  if (guide.schemaVersion !== 1) throw new Error('Engineering guide schemaVersion must be 1.');
  list(guide.pages, 'Guide pages', 32);
  const references = [];
  const links = [];
  const pages = new Map();
  const strings = [];
  const prose = (value, label, maximum) => { text(value, label, maximum); strings.push(value); };
  const sources = values => {
    list(values, 'Source references', 20);
    for (const source of values) {
      record(source, ['path', 'label'], ['find'], 'Source reference');
      if (!sourcePathAllowed(source.path)) throw new Error('Source reference path is not allowlisted.');
      prose(source.label, 'Source label', 160);
      if (source.find !== undefined) text(source.find, 'Source anchor', 300);
      references.push(source);
    }
  };
  for (const page of guide.pages) {
    record(page, ['slug', 'title', 'eyebrow', 'description', 'readingMinutes', 'sections'], [], 'Guide page');
    if (typeof page.slug !== 'string' || page.slug.length > 160 || !slugPattern.test(page.slug)
      || page.slug.split('/').some(part => ['guide.css', 'guide.js', 'manifest.json'].includes(part)) || pages.has(page.slug)) {
      throw new Error('Guide page slug is invalid or duplicated.');
    }
    prose(page.title, 'Page title', 160); prose(page.eyebrow, 'Page eyebrow', 100);
    prose(page.description, 'Page description', 500);
    if (!Number.isInteger(page.readingMinutes) || page.readingMinutes < 1 || page.readingMinutes > 60) {
      throw new Error('Page readingMinutes must be an integer from 1 to 60.');
    }
    list(page.sections, 'Page sections', 32);
    const ids = new Set(); pages.set(page.slug, ids);
    for (const section of page.sections) {
      record(section, ['id', 'title'], ['body', 'layout', 'items', 'steps', 'code', 'sources', 'callout'], 'Guide section');
      if (typeof section.id !== 'string' || section.id.length > 80 || !idPattern.test(section.id) || ids.has(section.id)) {
        throw new Error('Section id is invalid or duplicated within its page.');
      }
      ids.add(section.id); prose(section.title, 'Section title', 160);
      if (section.body !== undefined) { list(section.body, 'Section paragraphs', 16); section.body.forEach(value => prose(value, 'Paragraph')); }
      if (section.layout !== undefined && !['cards', 'map', 'steps'].includes(section.layout)) throw new Error('Unsupported section layout.');
      if (section.items !== undefined) {
        list(section.items, 'Section items', 24);
        for (const item of section.items) {
          record(item, ['title', 'text'], ['href'], 'Section item');
          prose(item.title, 'Item title', 160); prose(item.text, 'Item text');
          if (item.href !== undefined) { text(item.href, 'Item link', 300); links.push(item.href); }
        }
      }
      if (section.steps !== undefined) {
        list(section.steps, 'Walkthrough steps', 24);
        for (const step of section.steps) {
          record(step, ['title', 'text'], ['sources'], 'Walkthrough step');
          prose(step.title, 'Step title', 160); prose(step.text, 'Step text');
          if (step.sources !== undefined) sources(step.sources);
        }
      }
      if (section.code !== undefined) {
        record(section.code, ['language', 'text'], [], 'Code example');
        if (!['sh', 'bash', 'json', 'text', 'typescript'].includes(section.code.language)) throw new Error('Unsupported code example language.');
        prose(section.code.text, 'Code example', 6000);
      }
      if (section.sources !== undefined) sources(section.sources);
      if (section.callout !== undefined) {
        record(section.callout, ['title', 'text'], [], 'Section callout');
        prose(section.callout.title, 'Callout title', 160); prose(section.callout.text, 'Callout text');
      }
    }
  }
  if (!pages.has('')) throw new Error('Engineering guide requires a root page with slug "".');
  for (const href of links) {
    const match = /^\/engineering(?:\/([a-z0-9/-]+))?(?:#([a-z0-9-]+))?$/.exec(href);
    const slug = match?.[1] || '';
    if (!match || !pages.has(slug) || (match[2] && !pages.get(slug).has(match[2]))) {
      throw new Error(`Engineering link does not resolve: ${href}`);
    }
  }
  for (const value of strings) {
    for (const match of value.matchAll(/\bnpm\s+run\s+([A-Za-z0-9:_-]+)/g)) {
      if (!Object.hasOwn(scripts, match[1])) throw new Error(`Documented npm script does not exist: ${match[1]}`);
    }
  }
  if (references.length > 512) throw new Error('Engineering guide contains too many source references.');
  return references;
};

/** Reads one explicitly selected regular file without following source-tree symlinks. */
const readBoundedFile = async (root, relative, maximum = 4 * 1024 * 1024) => {
  const parts = relative.split('/');
  for (let index = 1; index <= parts.length; index++) {
    const candidate = path.join(root, ...parts.slice(0, index));
    let stats;
    try { stats = await lstat(candidate); } catch { throw new Error(`Engineering build input is missing: ${relative}`); }
    if (stats.isSymbolicLink() || (index < parts.length ? !stats.isDirectory() : !stats.isFile())) {
      throw new Error(`Engineering build input must use regular files and directories: ${relative}`);
    }
    if (index === parts.length && (!stats.size || stats.size > maximum)) throw new Error(`Engineering build input is empty or too large: ${relative}`);
  }
  return readFile(path.join(root, relative), 'utf8');
};
const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 8 * 1024 * 1024 });

/** Produces static pages from reviewed content; no application, database, or network is started. */
export const buildEngineeringGuide = async ({ sourceRoot = repositoryRoot, renderPage } = {}) => {
  const root = path.resolve(sourceRoot);
  let commit; let dirty; let tracked;
  try {
    commit = git(root, ['rev-parse', 'HEAD']).trim();
    dirty = !!git(root, ['status', '--porcelain', '--untracked-files=all']).trim();
    tracked = new Set(git(root, ['ls-files', '-z']).split('\0'));
  } catch { throw new Error('Engineering build requires a Git checkout with an existing commit.'); }
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('Engineering build requires a full 40-character Git commit.');
  const inputs = new Map();
  for (const relative of [guidePath, rendererPath, localizationPath, interfacePath, translationPath, 'package.json', ...assetNames.map(name => `engineering/${name}`)]) {
    inputs.set(relative, await readBoundedFile(root, relative, relative === guidePath ? 256 * 1024 : 4 * 1024 * 1024));
  }
  let guide; let packageFile; let ui; let translation;
  try {
    guide = JSON.parse(inputs.get(guidePath)); packageFile = JSON.parse(inputs.get('package.json'));
    ui = JSON.parse(inputs.get(interfacePath)); translation = JSON.parse(inputs.get(translationPath));
  } catch { throw new Error('Engineering guide, localization inputs and package.json must contain valid JSON.'); }
  const references = validateEngineeringGuide(guide, packageFile.scripts || {});
  const sourceLinks = Object.create(null);
  let sourceBytes = 0;
  for (const source of references) {
    if (!tracked.has(source.path)) throw new Error(`Engineering source reference must be tracked by Git: ${source.path}`);
    if (!inputs.has(source.path)) inputs.set(source.path, await readBoundedFile(root, source.path));
    const contents = inputs.get(source.path);
    sourceBytes += Buffer.byteLength(contents);
    if (sourceBytes > 32 * 1024 * 1024) throw new Error('Engineering source references exceed the build input budget.');
    const offset = source.find ? contents.indexOf(source.find) : 0;
    if (offset === -1) throw new Error(`Engineering source anchor is missing: ${source.path}`);
    const line = contents.slice(0, offset).split('\n').length;
    sourceLinks[`${source.path}#${source.find || ''}`] = `https://github.com/yangyinxu/Archtree/blob/${commit}/${source.path}#L${line}`;
  }
  const localized = localizeEngineeringGuide(guide, ui, translation);
  validateEngineeringGuide(localized.guide, packageFile.scripts || {});
  const editions = [{ locale: 'en-US', guide, ui }, { locale: 'zh-Hans', ...localized }];
  const generated = editions.flatMap(edition => edition.guide.pages.map(page => ({
    ...edition, page,
    slug: [engineeringLocales.find(value => value.locale === edition.locale).prefix, page.slug].filter(Boolean).join('/')
  })));
  // The server and release validator apply their limits to the complete bilingual bundle.
  if (generated.length > 32 || new Set(generated.map(page => page.slug)).size !== generated.length
    || guide.pages.some(page => page.slug === 'zh-hans' || page.slug.startsWith('zh-hans/'))
    || generated.some(page => page.slug.length > 160 || !slugPattern.test(page.slug))) {
    throw new Error('Localized engineering pages exceed the route limits or use a reserved locale prefix.');
  }
  const hash = createHash('sha256');
  for (const [filename, contents] of [...inputs].sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(JSON.stringify([filename, contents]));
  }
  const metadata = { revision: { commit, dirty }, sourceDigest: hash.digest('hex'), sourceLinks };
  const renderer = renderPage || (await import(pathToFileURL(path.join(root, rendererPath)).href)).renderEngineeringPage;
  if (typeof renderer !== 'function') throw new Error('Engineering renderer must export renderEngineeringPage.');
  const manifest = { schemaVersion: 1, revision: metadata.revision, sourceDigest: metadata.sourceDigest,
    pages: generated.map(({ slug, page: { title, description } }) => ({ slug, title, description, file: slug ? `${slug}/index.html` : 'index.html' })),
    assets: assetNames };
  const outputRoot = path.join(root, 'engineering');
  const destination = path.join(outputRoot, 'dist');
  try {
    const stats = await lstat(destination);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('Engineering output must be a regular directory.');
    if ((await readdir(destination)).length) {
      let prior;
      try { prior = JSON.parse(await readFile(path.join(destination, 'manifest.json'), 'utf8')); } catch { /* handled below */ }
      if (prior?.schemaVersion !== 1 || !Array.isArray(prior.pages)) throw new Error('Refusing to replace an unrecognized engineering/dist directory.');
    }
  } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const temporary = path.join(outputRoot, `.dist-${randomUUID()}`);
  try {
    await mkdir(temporary);
    for (let index = 0; index < generated.length; index++) {
      const { page, guide: edition, locale, ui: messages } = generated[index];
      const html = renderer(page, edition, { ...metadata, locale, ui: messages });
      if (typeof html !== 'string' || !html.trim() || Buffer.byteLength(html) > 512 * 1024) throw new Error('Engineering renderer returned an invalid or oversized page.');
      const filename = path.join(temporary, manifest.pages[index].file);
      await mkdir(path.dirname(filename), { recursive: true });
      await writeFile(filename, html, 'utf8');
    }
    for (const name of assetNames) await writeFile(path.join(temporary, name), inputs.get(`engineering/${name}`), 'utf8');
    await writeFile(path.join(temporary, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await rm(destination, { recursive: true, force: true });
    await rename(temporary, destination);
  } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
  return { outputDirectory: destination, manifest };
};

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMainModule) {
  if (process.argv.length > 2) { console.error('Engineering build accepts no path arguments.'); process.exitCode = 1; }
  else buildEngineeringGuide().then(({ manifest }) => {
    console.log(`Built ${manifest.pages.length} engineering pages from ${manifest.revision.commit}${manifest.revision.dirty ? ' (working copy)' : ''}.`);
  }).catch(error => { console.error(error instanceof Error ? error.message : 'Engineering build failed.'); process.exitCode = 1; });
}
