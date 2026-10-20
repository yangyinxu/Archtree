import assert from 'node:assert/strict';
import test from 'node:test';
import { catalogFile } from '../../scripts/build-catalogs.mjs';

/**
 * Covers the catalog generator's line-ending contract. Windows checkouts hold CRLF
 * copies; a marker compared with its trailing `\r` once went unrecognized, and the
 * generator inserted a second catalog into every long document it touched.
 */
const toCrlf = (text: string) => text.replace(/\n/g, '\r\n');

/** Builds a Markdown document long enough to need a catalog. */
const longDocument = () => ['# Guide', '', 'Introduction.', '',
    ...Array.from({ length: 30 }, (_, index) => [`## Section ${index + 1}`, '', 'Body.', '']).flat()].join('\n');

/** Builds a module long enough to need a catalog. */
const longModule = () => `${Array.from({ length: 110 }, (_, index) => `export const value${index} = ${index};`).join('\n')}\n`;

/** Counts Markdown catalog start lines, with or without a carriage return. */
const markdownBlocks = (text: string) => text.match(/^<!-- @catalog -->\r?$/gm)?.length ?? 0;

/** Reports whether any line break is a bare LF, which would leave a CRLF file with mixed endings. */
const hasBareLf = (text: string) => /(^|[^\r])\n/.test(text);

const currentDocument = catalogFile('docs/guide.md', longDocument()).content;

test('adds one catalog to a long LF document and leaves it unchanged on the next run', () => {
    const first = catalogFile('docs/guide.md', longDocument());
    assert.equal(first.changed, true);
    assert.equal(markdownBlocks(first.content), 1);
    assert.equal(first.content.includes('\r'), false);
    const second = catalogFile('docs/guide.md', first.content);
    assert.equal(second.changed, false);
    assert.equal(second.content, first.content);
});

test('reports a CRLF document with a current catalog as current, byte for byte', () => {
    const checkout = toCrlf(currentDocument);
    const result = catalogFile('docs/guide.md', checkout);
    assert.equal(result.changed, false);
    assert.equal(result.content, checkout);
});

test('adds one catalog to a long CRLF document in CRLF', () => {
    const result = catalogFile('docs/guide.md', toCrlf(longDocument()));
    assert.equal(result.changed, true);
    assert.equal(result.content, toCrlf(currentDocument));
    assert.equal(hasBareLf(result.content), false);
});

test('replaces a stale CRLF catalog with exactly one block', () => {
    const stale = toCrlf(currentDocument.replace('- [Section 1](#section-1)', '- [Old title](#old-title)'));
    const result = catalogFile('docs/guide.md', stale);
    assert.equal(result.changed, true);
    assert.equal(markdownBlocks(result.content), 1);
    assert.equal(result.content, toCrlf(currentDocument));
});

test('reports a CRLF code catalog as current instead of failing as unterminated', () => {
    const current = catalogFile('src/example.ts', longModule()).content;
    assert.equal(catalogFile('src/example.ts', current).changed, false);
    const result = catalogFile('src/example.ts', toCrlf(current));
    assert.equal(result.changed, false);
    assert.equal(result.content, toCrlf(current));
});

test('removes the catalog from a CRLF document that became short', () => {
    const short = toCrlf(['# Note', '', '<!-- @catalog -->', '**Contents**', '', '- [Usage](#usage)',
        '<!-- @end-catalog -->', '', '## Usage', '', 'Body.', ''].join('\n'));
    const result = catalogFile('docs/note.md', short);
    assert.equal(result.changed, true);
    assert.equal(result.content, toCrlf(['# Note', '', '## Usage', '', 'Body.', ''].join('\n')));
});

test('refuses a document that already carries two catalog blocks', () => {
    const block = currentDocument.match(/<!-- @catalog -->[\s\S]*?<!-- @end-catalog -->\n\n/)?.[0] ?? '';
    assert.notEqual(block, '');
    const doubled = currentDocument.replace(block, `${block}${block}`);
    assert.throws(() => catalogFile('docs/guide.md', doubled), /More than one catalog block/);
    assert.throws(() => catalogFile('docs/guide.md', toCrlf(doubled)), /More than one catalog block/);
    // The incident left an LF block after a CRLF one; normalization still sees both.
    assert.throws(() => catalogFile('docs/guide.md', toCrlf(currentDocument).replace('## Section 1', `${block}## Section 1`)),
        /More than one catalog block/);
});
