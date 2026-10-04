import assert from 'node:assert/strict';
import test from 'node:test';

const rendererUrl = new URL('../scripts/lib/engineering-renderer.mjs', import.meta.url);

test('engineering text cannot inject HTML, attributes, or executable code', async () => {
  const { renderEngineeringPage } = await import(rendererUrl.href);
  const attack = '<img src=x onerror="alert(1)">';
  const page = {
    slug: '', title: attack, eyebrow: attack, description: attack, readingMinutes: 5,
    sections: [{ id: 'safe', title: attack, body: [attack], items: [{ title: attack, text: attack }],
      steps: [{ title: attack, text: attack }], code: { language: 'sh', text: attack }, callout: { title: attack, text: attack } }]
  };
  const html = renderEngineeringPage(page, { pages: [page] }, {
    revision: { commit: 'a'.repeat(40), dirty: false }, sourceDigest: 'b'.repeat(64), sourceLinks: {}
  });
  assert.doesNotMatch(html, /<img|onerror="|<script(?! src=)/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(html, /<main id="main-content" tabindex="-1">/);
});

test('working-copy previews explain why source links refer to the base commit', async () => {
  const { renderEngineeringPage } = await import(rendererUrl.href);
  const page = { slug: '', title: 'Overview', eyebrow: 'Guide', description: 'Start here', readingMinutes: 5, sections: [] };
  const metadata = { revision: { commit: 'a'.repeat(40), dirty: true }, sourceDigest: 'b'.repeat(64), sourceLinks: {} };
  assert.match(renderEngineeringPage(page, { pages: [page] }, metadata), /Source links open the base commit/);
  assert.doesNotMatch(renderEngineeringPage(page, { pages: [page] }, { ...metadata, revision: { ...metadata.revision, dirty: false } }), /Working copy/);
});
