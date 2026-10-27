/**
 * The pure comparison of an existing-Album review's searched title with a release title (lookupTitleNormalize.ts): width and case
 * folded, a trailing credit, a leading or trailing primary Artist name or part of a decorated one and brackets removed, and
 * totality on any input. Titles and names are synthetic or shaped like real catalog titles; no network.
 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { comparableLookupTitle, sameLookupTitle } from '../../src/administration/lookup/lookupTitleNormalize';
import { installNetworkGuard } from '../support/networkGuard';

const guard = installNetworkGuard();
after(() => { guard.restore(); assert.deepEqual(guard.attempts, []); });

test('a searched title and a release title compare after NFKC, lower case, a trailing credit, a primary Artist name or part of a decorated one, and brackets', () => {
    assert.equal(comparableLookupTitle('CANDY LIVE 2', []), 'candy live 2');
    assert.equal(sameLookupTitle('CANDY LIVE 2', 'ＣＡＮＤＹ　ＬＩＶＥ　２', []), true, 'full-width letters, digits and spaces fold');
    assert.equal(comparableLookupTitle('合成美嘉 Synthetic Best BIBLE／合成美嘉', ['合成美嘉']), 'synthetic best bible', 'a trailing credit, then a leading name');
    assert.equal(sameLookupTitle('雪の華15周年記念ベスト盤 BIBLE／中島美嘉', '雪の華15周年記念ベスト盤 BIBLE', ['中島美嘉']), true);
    assert.equal(comparableLookupTitle('アニメ「合成少女☆マギカ」Ultimate Best／Synthetic Label', []), 'アニメ 合成少女☆マギカ ultimate best', 'any trailing credit goes');
    assert.equal(comparableLookupTitle('Synthetic Best / Synthetic Label', []), 'synthetic best', 'an ASCII slash with spaces on both sides marks a credit');
    // A decorated name goes whole or by either part, at the start or the end, also beside a bracket once brackets are spaces.
    const decorated = ['合成情緒 -Gouseijoucho-'];
    for (const [title, expected] of [['合成情緒 2nd Album「色彩」', '2nd album 色彩'], ['Gouseijoucho 2nd Album「色彩」', '2nd album 色彩'],
        ['合成情緒 -Gouseijoucho- Live 2', 'live 2'], ['Live 2 合成情緒', 'live 2'], ['「色彩」合成情緒', '色彩'], ['Live 2 (Gouseijoucho)', 'live 2']] as const) {
        assert.equal(comparableLookupTitle(title, decorated), expected, title);
    }
    // A title that is only a name or only a credit keeps it; a name inside a word or without a space beside it stays.
    assert.deepEqual([comparableLookupTitle('合成情緒', decorated), comparableLookupTitle('／Synthetic', []), comparableLookupTitle('/x', []),
        comparableLookupTitle('合成情緒Live', decorated), comparableLookupTitle('Synthetic Ensembles Live', ['Synthetic Ensemble'])],
    ['合成情緒', '/synthetic', '/x', '合成情緒live', 'synthetic ensembles live']);
    // A slash inside a title is not a credit, so such titles stay apart.
    assert.deepEqual([comparableLookupTitle('Love/Hate', []), comparableLookupTitle('AC/DC Live', [])], ['love/hate', 'ac/dc live']);
    assert.equal(sameLookupTitle('Fate/Zero Synthetic Soundtrack', 'Fate/stay night Synthetic Soundtrack', []), false);
    // A slash without spaces ends the title only before one of the names (or a part of a decorated one), as the run searches it.
    assert.equal(sameLookupTitle('雪の華15周年記念ベスト盤 BIBLE/中島美嘉', '雪の華15周年記念ベスト盤 BIBLE', ['中島美嘉']), true);
    assert.equal(sameLookupTitle('Back in Black/AC/DC', 'Back in Black', ['AC/DC']), true);
    assert.equal(comparableLookupTitle('Synthetic Best/Gouseijoucho', decorated), 'synthetic best');
    assert.deepEqual([sameLookupTitle('Fate/Zero', 'Fate', ['Synthetic Ensemble']), sameLookupTitle('Synthetic Best/Other Name', 'Synthetic Best', ['Synthetic Ensemble'])],
        [false, false]);
    // A slash with nothing after it is no credit.
    assert.deepEqual([sameLookupTitle('abc／', 'abc', []), sameLookupTitle('abc / ', 'abc', [])], [false, false]);
    assert.deepEqual([comparableLookupTitle('abc／', []), comparableLookupTitle('abc / ', [])], ['abc/', 'abc /']);
    // A name read loosely by the review page but not decorated here stays.
    assert.equal(comparableLookupTitle('Synthetic Live (Synthetic Band)', ['Synthetic Name (Synthetic Band)']), 'synthetic live synthetic band');
});

test('a title that does not compare is never the same, comparison is symmetric, and names that cannot be read are ignored', () => {
    for (const title of [null, undefined, 7, ['CANDY'], 'x'.repeat(1001), '「」', '( ) [ ]', '   ']) assert.equal(comparableLookupTitle(title, []), null, String(title).slice(0, 12));
    assert.equal(comparableLookupTitle('x'.repeat(1000), []), 'x'.repeat(1000));
    assert.deepEqual([sameLookupTitle(null, null, []), sameLookupTitle('「」', '()', []), sameLookupTitle('Synthetic', null, []), sameLookupTitle(null, 'Synthetic', [])],
        [false, false, false, false]);
    for (const [left, right] of [['Synthetic Live 2', 'synthetic  live 2'], ['Synthetic Best／合成美嘉', 'Synthetic Best'], ['A', 'B']]) {
        assert.equal(sameLookupTitle(left, right, ['合成美嘉']), sameLookupTitle(right, left, ['合成美嘉']), `${left} ${right}`);
    }
    // Names that are no strings or are over 200 characters are never read; a non-array is no names.
    assert.equal(comparableLookupTitle('Synthetic Ensemble Live', [7, null, `${'x'.repeat(201)}`, { name: 'Synthetic Ensemble' }]), 'synthetic ensemble live');
    assert.equal(comparableLookupTitle('Synthetic Ensemble Live', 'Synthetic Ensemble' as never), 'synthetic ensemble live');
    assert.equal(comparableLookupTitle('Synthetic Ensemble Live', ['Synthetic Ensemble']), 'live');
});
