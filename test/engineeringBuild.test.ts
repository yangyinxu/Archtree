import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildEngineeringGuide, validateEngineeringGuide } from '../scripts/build-engineering.mjs';
import { collectEngineeringMessages, engineeringTranslationDigest } from '../scripts/lib/engineering-localization.mjs';

const guide = () => ({ schemaVersion: 1, pages: [
  { slug: '', title: 'Engineering', eyebrow: 'Start here', description: 'Understand the service.', readingMinutes: 3,
    sections: [{ id: 'start', title: 'Get started', body: ['Run npm run doctor.'],
      items: [{ title: 'System map', text: 'Follow a request.', href: '/engineering/system/map#request' }],
      sources: [{ path: 'README.md', label: 'Readme', find: 'A bounded source anchor.' }] }] },
  { slug: 'system/map', title: 'System map', eyebrow: 'Architecture', description: 'Read the boundaries.', readingMinutes: 5,
    sections: [{ id: 'request', title: 'Trace a request', layout: 'steps', steps: [{ title: 'Enter', text: 'Validate input.' }],
      code: { language: 'sh', text: 'npm run build' }, callout: { title: 'Contract', text: 'Preserve owner checks.' } }] }
] });
const scripts = { doctor: 'node check.mjs', build: 'node build.mjs' };
const ui = { 'ui.fixture': 'Read for {minutes} minutes' };
const html = '<!doctype html><link rel="stylesheet" href="/engineering/guide.css"><script defer src="/engineering/guide.js"></script>';
const put = async (root: string, filename: string, contents: string) => {
  await mkdir(path.dirname(path.join(root, filename)), { recursive: true });
  await writeFile(path.join(root, filename), contents);
};
const git = (root: string, args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
/** Synthetic translations track each fixture's English content; real translations are checked separately. */
const translate = async (root: string, value: any) => {
  const messages = collectEngineeringMessages(value, ui);
  await put(root, 'docs/engineering/locales/zh-Hans.json', JSON.stringify({
    schemaVersion: 1, locale: 'zh-Hans', sourceDigest: engineeringTranslationDigest(messages), messages
  }));
};
/** Creates a real, credential-free Git checkout so revision tests exercise normal build identity. */
const fixture = async (t: { after: (fn: () => Promise<void>) => void }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'archtree-engineering-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await put(root, '.gitignore', 'engineering/dist\n');
  await put(root, 'package.json', JSON.stringify({ scripts }));
  await put(root, 'docs/engineering/guide.json', JSON.stringify(guide()));
  await put(root, 'engineering/locales/en-US.json', JSON.stringify(ui));
  await put(root, 'scripts/lib/engineering-localization.mjs', await readFile(new URL('../scripts/lib/engineering-localization.mjs', import.meta.url), 'utf8'));
  await translate(root, guide());
  await put(root, 'README.md', '# Fixture\n\nA bounded source anchor.\nPRIVATE SOURCE SENTINEL\n');
  await put(root, '.env.example', 'DB_NAME=replace-with-development-name\n');
  await put(root, 'engineering/guide.css', 'body { color: black; }');
  await put(root, 'engineering/guide.js', '"use strict";');
  await put(root, 'scripts/lib/engineering-renderer.mjs', `export const renderEngineeringPage = () => ${JSON.stringify(html)};`);
  for (const args of [['init', '-q'], ['config', 'user.name', 'Guide Test'], ['config', 'user.email', 'guide-test@example.invalid'],
    ['add', '.'], ['commit', '-q', '--no-gpg-sign', '-m', 'fixture']]) git(root, args);
  return root;
};

test('builds only static allowlisted pages/assets with pinned source lines and exact clean identity', async t => {
  const root = await fixture(t); let captured: any;
  const result = await buildEngineeringGuide({ sourceRoot: root, renderPage: (_page: any, _guide: any, metadata: any) => { captured = metadata; return html; } });
  assert.deepEqual(result.manifest.revision, { commit: git(root, ['rev-parse', 'HEAD']).trim(), dirty: false });
  assert.match(result.manifest.sourceDigest, /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(result.manifest), ['schemaVersion', 'revision', 'sourceDigest', 'pages', 'assets']);
  assert.deepEqual(await readdir(result.outputDirectory), ['guide.css', 'guide.js', 'index.html', 'manifest.json', 'system', 'zh-hans']);
  assert.deepEqual(result.manifest.pages.map((page: any) => page.slug), ['', 'system/map', 'zh-hans', 'zh-hans/system/map']);
  assert.equal(await readFile(path.join(result.outputDirectory, 'zh-hans/system/map/index.html'), 'utf8'), html);
  assert.match(captured.sourceLinks['README.md#A bounded source anchor.'], /\/blob\/[0-9a-f]{40}\/README\.md#L3$/);
  assert.equal(await readFile(path.join(result.outputDirectory, 'system/map/index.html'), 'utf8'), html);
  assert.doesNotMatch(await readFile(path.join(result.outputDirectory, 'index.html'), 'utf8'), /PRIVATE SOURCE SENTINEL/);
  assert.equal(git(root, ['status', '--porcelain']).trim(), '', 'Generated output is ignored.');
  const repeated = await buildEngineeringGuide({ sourceRoot: root });
  assert.deepEqual(repeated.manifest, result.manifest);
});

test('working-copy changes are visible and selected source changes change the source digest', async t => {
  const root = await fixture(t);
  const first = await buildEngineeringGuide({ sourceRoot: root });
  await put(root, 'README.md', '# Fixture\n\nA bounded source anchor.\nChanged source.\n');
  const changed = await buildEngineeringGuide({ sourceRoot: root });
  assert.equal(changed.manifest.revision.commit, first.manifest.revision.commit);
  assert.equal(changed.manifest.revision.dirty, true);
  assert.notEqual(changed.manifest.sourceDigest, first.manifest.sourceDigest);
});

test('untracked files mark a working copy while ignored generated output does not', async t => {
  const root = await fixture(t);
  await put(root, 'scratch.txt', 'local scratch');
  assert.equal((await buildEngineeringGuide({ sourceRoot: root })).manifest.revision.dirty, true);
});

for (const [label, mutate, expected] of [
  ['unknown page fields', (value: any) => { value.pages[0].rawHtml = '<script>'; }, /unsupported fields/],
  ['duplicate slugs', (value: any) => { value.pages[1].slug = ''; }, /slug/],
  ['escaping slugs', (value: any) => { value.pages[1].slug = '../outside'; }, /slug/],
  ['excessive slug depth', (value: any) => { value.pages[1].slug = 'one/two/three/four/five'; }, /slug/],
  ['missing root page', (value: any) => { value.pages[0].slug = 'home'; }, /root page/],
  ['duplicate section anchors', (value: any) => { value.pages[0].sections.push(value.pages[0].sections[0]); }, /Section id/],
  ['missing page links', (value: any) => { value.pages[0].sections[0].items[0].href = '/engineering/missing'; }, /does not resolve/],
  ['missing section links', (value: any) => { value.pages[0].sections[0].items[0].href = '/engineering/system/map#missing'; }, /does not resolve/],
  ['executable links', (value: any) => { value.pages[0].sections[0].items[0].href = 'javascript:alert(1)'; }, /does not resolve/],
  ['unknown npm commands', (value: any) => { value.pages[0].sections[0].body = ['npm run missing:command']; }, /script does not exist/],
  ['secret sources', (value: any) => { value.pages[0].sections[0].sources[0].path = '.env'; }, /not allowlisted/],
  ['escaping sources', (value: any) => { value.pages[0].sections[0].sources[0].path = 'docs/../README.md'; }, /not allowlisted/],
  ['unsupported source fields', (value: any) => { value.pages[0].sections[0].sources[0].includeContents = true; }, /unsupported fields/],
  ['unbounded paragraphs', (value: any) => { value.pages[0].sections[0].body = ['x'.repeat(3001)]; }, /at most/]
] as const) {
  test(`rejects ${label} before rendering`, () => {
    const value = guide(); mutate(value);
    assert.throws(() => validateEngineeringGuide(value, scripts), expected);
  });
}

test('requires source references to be tracked and anchors to exist', async t => {
  const root = await fixture(t);
  await put(root, 'README.md', '# Replaced source\n');
  await assert.rejects(buildEngineeringGuide({ sourceRoot: root }), /source anchor is missing/);
  const value = guide(); value.pages[0].sections[0].sources![0] = { path: 'docs/untracked.md', label: 'Untracked', find: 'anchor' };
  await put(root, 'docs/untracked.md', 'anchor'); await put(root, 'docs/engineering/guide.json', JSON.stringify(value));
  await assert.rejects(buildEngineeringGuide({ sourceRoot: root }), /must be tracked/);
});

test('rejects source symlinks without reading their target', async t => {
  const root = await fixture(t);
  await rm(path.join(root, 'README.md'));
  await symlink('package.json', path.join(root, 'README.md'));
  await assert.rejects(buildEngineeringGuide({ sourceRoot: root }), /regular files and directories/);
});

test('missing build assets fail with an actionable filename', async t => {
  const root = await fixture(t);
  await rm(path.join(root, 'engineering/guide.js'));
  await assert.rejects(buildEngineeringGuide({ sourceRoot: root }), /input is missing: engineering\/guide\.js/);
});

test('a failed render preserves the previous distribution and cleans temporary output', async t => {
  const root = await fixture(t);
  const first = await buildEngineeringGuide({ sourceRoot: root });
  await assert.rejects(buildEngineeringGuide({ sourceRoot: root, renderPage: () => { throw new Error('Synthetic renderer failure'); } }), /Synthetic renderer failure/);
  assert.equal(await readFile(path.join(first.outputDirectory, 'index.html'), 'utf8'), html);
  assert.deepEqual((await readdir(path.join(root, 'engineering'))).sort(), ['dist', 'guide.css', 'guide.js', 'locales']);
});

test('refuses to replace an unrecognized output directory or symbolic-link output', async t => {
  const root = await fixture(t);
  await put(root, 'engineering/dist/preserve.txt', 'unrelated');
  await assert.rejects(buildEngineeringGuide({ sourceRoot: root }), /unrecognized/);
  assert.equal(await readFile(path.join(root, 'engineering/dist/preserve.txt'), 'utf8'), 'unrelated');
  await rm(path.join(root, 'engineering/dist'), { recursive: true });
  await symlink('../docs', path.join(root, 'engineering/dist'));
  await assert.rejects(buildEngineeringGuide({ sourceRoot: root }), /regular directory/);
});


test('links a tracked environment template without rendering its contents', async t => {
  const root = await fixture(t); const value = guide(); let captured: any;
  value.pages[0].sections[0].sources!.push({ path: '.env.example', label: 'Configuration template', find: 'DB_NAME=' });
  await put(root, 'docs/engineering/guide.json', JSON.stringify(value));
  await translate(root, value);
  const result = await buildEngineeringGuide({ sourceRoot: root, renderPage: (_page: any, _guide: any, metadata: any) => {
    captured = metadata; return html;
  } });
  assert.match(captured.sourceLinks['.env.example#DB_NAME='], /\/blob\/[0-9a-f]{40}\/\.env\.example#L1$/);
  assert.doesNotMatch(JSON.stringify(captured), /replace-with-development-name/);
  assert.doesNotMatch(await readFile(path.join(result.outputDirectory, 'index.html'), 'utf8'), /DB_NAME=/);
});

test('translation failures preserve the last complete bilingual distribution', async t => {
  const root = await fixture(t);
  const first = await buildEngineeringGuide({ sourceRoot: root });
  const previous = await readFile(path.join(first.outputDirectory, 'manifest.json'), 'utf8');
  const translationPath = 'docs/engineering/locales/zh-Hans.json';
  const original = JSON.parse(await readFile(path.join(root, translationPath), 'utf8'));
  for (const [mutate, expected] of [
    [(value: any) => { delete value.messages['page.overview.title']; }, /keys must exactly match/],
    [(value: any) => { value.messages['ui.fixture'] = '阅读分钟'; }, /variables do not match/],
    [(value: any) => { value.sourceDigest = '0'.repeat(64); }, /invalid or stale/],
    [(value: any) => { value.messages['page.overview.title'] = '文'.repeat(161); }, /Page title/]
  ] as const) {
    const value = structuredClone(original); mutate(value);
    await put(root, translationPath, JSON.stringify(value));
    await assert.rejects(buildEngineeringGuide({ sourceRoot: root }), expected);
    assert.equal(await readFile(path.join(first.outputDirectory, 'manifest.json'), 'utf8'), previous);
    assert.equal(await readFile(path.join(first.outputDirectory, 'zh-hans/index.html'), 'utf8'), html);
  }
});

test('translation edits affect bundle identity without changing the English source digest', async t => {
  const root = await fixture(t);
  const first = await buildEngineeringGuide({ sourceRoot: root });
  const filename = 'docs/engineering/locales/zh-Hans.json';
  const translation = JSON.parse(await readFile(path.join(root, filename), 'utf8'));
  translation.messages['page.overview.title'] = '工程指南';
  await put(root, filename, JSON.stringify(translation));
  const changed = await buildEngineeringGuide({ sourceRoot: root });
  assert.notEqual(first.manifest.sourceDigest, changed.manifest.sourceDigest);
  assert.equal(changed.manifest.pages.find((page: any) => page.slug === 'zh-hans')?.title, '工程指南');
});

for (const constraint of ['page count', 'slug depth', 'slug length', 'reserved prefix']) {
  test(`checks localized ${constraint} against the deployed route contract`, async t => {
    const root = await fixture(t); const value = guide();
    if (constraint === 'page count') {
      for (let index = 0; index < 15; index++) value.pages.push({ ...value.pages[1], slug: `extra-${index}` });
    } else {
      value.pages[1].slug = constraint === 'slug depth' ? 'one/two/three/four'
        : constraint === 'slug length' ? 'a'.repeat(155) : 'zh-hans';
      value.pages[0].sections[0].items![0].href = `/engineering/${value.pages[1].slug}#request`;
    }
    await put(root, 'docs/engineering/guide.json', JSON.stringify(value));
    await translate(root, value);
    await assert.rejects(buildEngineeringGuide({ sourceRoot: root }), /route limits|reserved locale prefix/);
  });
}
