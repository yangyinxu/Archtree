import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { collectEngineeringMessages, engineeringTranslationDigest, engineeringPagePath, localizeEngineeringGuide } from '../scripts/lib/engineering-localization.mjs';
import { renderEngineeringPage } from '../scripts/lib/engineering-renderer.mjs';

const read = async (relative: string) => JSON.parse(await readFile(new URL(relative, import.meta.url), 'utf8'));

/** Exercises the actual maintained translations, including source labels and accessible interface copy. */
const sources = async () => ({
  guide: await read('../docs/engineering/guide.json'),
  ui: await read('../engineering/locales/en-US.json'),
  translation: await read('../docs/engineering/locales/zh-Hans.json')
});

test('all maintained Chinese messages match current English source and preserve executable examples', async () => {
  const { guide, ui, translation } = await sources();
  const original = structuredClone(guide);
  const localized = localizeEngineeringGuide(guide, ui, translation);
  assert.equal(localized.guide.pages.length, guide.pages.length);
  assert.deepEqual(guide, original, 'Localization must not mutate the English source.');
  for (let index = 0; index < guide.pages.length; index++) {
    const english = guide.pages[index]; const chinese = localized.guide.pages[index];
    assert.equal(chinese.slug, english.slug);
    assert.match(chinese.description, /[\u3400-\u9fff]/);
    for (let sectionIndex = 0; sectionIndex < english.sections.length; sectionIndex++) {
      const before = english.sections[sectionIndex]; const after = chinese.sections[sectionIndex];
      assert.equal(after.id, before.id);
      assert.deepEqual(after.code, before.code);
      assert.deepEqual(after.items?.map((item: any) => item.href), before.items?.map((item: any) => item.href));
      assert.deepEqual(after.sources?.map(({ path, find }: any) => ({ path, find })), before.sources?.map(({ path, find }: any) => ({ path, find })));
      assert.deepEqual(after.steps?.map((step: any) => step.sources?.map(({ path, find }: any) => ({ path, find }))), before.steps?.map((step: any) => step.sources?.map(({ path, find }: any) => ({ path, find }))));
    }
  }
});

test('changed English copy and reordered content require explicit translation review', async () => {
  const { guide, ui, translation } = await sources();
  const changed = structuredClone(guide);
  changed.pages[0].description += ' Revised.';
  assert.throws(() => localizeEngineeringGuide(changed, ui, translation), /invalid or stale/);
  const withItems = changed.pages.flatMap((page: any) => page.sections).find((section: any) => section.items?.length > 1);
  const reordered = structuredClone(guide);
  const section = reordered.pages.flatMap((page: any) => page.sections).find((entry: any) => entry.id === withItems.id && entry.items?.length > 1);
  section.items.reverse();
  assert.throws(() => localizeEngineeringGuide(reordered, ui, translation), /invalid or stale/);
});

test('translation keys, values, locale identity and placeholders cannot silently fall back to English', async () => {
  const { guide, ui, translation } = await sources();
  for (const [mutate, expected] of [
    [(value: any) => { value.locale = 'zh-CN'; }, /invalid or stale/],
    [(value: any) => { value.messages['ui.unused'] = '多余'; }, /keys must exactly match/],
    [(value: any) => { delete value.messages['ui.skip']; }, /keys must exactly match/],
    [(value: any) => { value.messages['ui.skip'] = ''; }, /Invalid engineering translation/],
    [(value: any) => { value.messages['ui.skip'] = '\u0000'; }, /Invalid engineering translation/],
    [(value: any) => { value.messages['ui.reading_time'] = '{count} 分钟'; }, /variables do not match/]
  ] as const) {
    const changed = structuredClone(translation); mutate(changed);
    assert.throws(() => localizeEngineeringGuide(guide, ui, changed), expected);
  }
  const english = collectEngineeringMessages(guide, ui);
  assert.equal(engineeringTranslationDigest(Object.fromEntries(Object.entries(english).reverse())), translation.sourceDigest);
});

test('Chinese rendering localizes topic links and accessible text while retaining shared assets and source URLs', async () => {
  const { guide, ui, translation } = await sources();
  const localized = localizeEngineeringGuide(guide, ui, translation);
  const page = localized.guide.pages.find((entry: any) => entry.slug === 'start');
  const sourceLinks: Record<string, string> = {};
  for (const section of page.sections) for (const source of [...(section.sources || []), ...(section.steps || []).flatMap((step: any) => step.sources || [])]) {
    sourceLinks[`${source.path}#${source.find || ''}`] = 'https://github.com/yangyinxu/Archtree/blob/' + 'a'.repeat(40) + '/' + source.path;
  }
  const metadata = { locale: 'zh-Hans', ui: localized.ui, revision: { commit: 'a'.repeat(40), dirty: false }, sourceLinks };
  const html = renderEngineeringPage(page, localized.guide, metadata);
  assert.match(html, /<html lang="zh-Hans">/);
  assert.match(html, /aria-label="工程指南"/);
  assert.match(html, /href="\/engineering\/zh-hans\/architecture"/);
  assert.match(html, /href="\/engineering\/start" lang="en-US"/);
  assert.match(html, /href="\/engineering\/zh-hans\/start" lang="zh-Hans" hreflang="zh-Hans" aria-current="true"/);
  assert.match(html, /href="\/engineering\/guide.css"/);
  assert.match(html, /data-copy-label="复制命令"/);
  assert.match(html, /data-copy-failure="复制失败。请选中命令后手动复制。"/);
  assert.doesNotMatch(html, /\/zh-hans\/guide\.(?:css|js)/);
  assert.match(html, /npm run doctor/);
  const unsafe = { ...metadata, ui: { ...localized.ui, 'ui.code.failure': '<img src=x onerror="alert(1)">' } };
  const escaped = renderEngineeringPage(page, localized.guide, unsafe);
  assert.doesNotMatch(escaped, /<img|onerror="/);
  assert.match(escaped, /data-copy-failure="&lt;img src=x onerror=&quot;/);
  assert.equal(engineeringPagePath('modules/catalog', 'zh-Hans'), '/engineering/zh-hans/modules/catalog');
  assert.equal(engineeringPagePath('', 'zh-Hans'), '/engineering/zh-hans');
  assert.throws(() => engineeringPagePath('', 'unknown'), /Unsupported engineering locale/);
});
