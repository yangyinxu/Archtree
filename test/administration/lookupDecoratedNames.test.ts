/**
 * The pure readers of decorated names (lookupDecoratedNames.ts): a name without Latin letters followed by its romanized form in
 * round brackets or between hyphens has two parts, read after NFKC, while disambiguations, romanized first parts, parts in two
 * scripts, placeholder parts and other brackets have none; and a saved Album title loses a trailing slash ending that equals a
 * primary Artist name or either part of a decorated one. Names are real artist names or synthetic; no network.
 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { decoratedNameParts, titleWithoutTrailingCredit } from '../../src/administration/lookup/lookupDecoratedNames';
import { installNetworkGuard } from '../support/networkGuard';

const guard = installNetworkGuard();
after(() => { guard.restore(); assert.deepEqual(guard.attempts, []); });

test('a native name with its romanized form in round brackets, full-width brackets or between hyphens has two parts, read after NFKC', () => {
    for (const name of ['ヰ世界情緒 -Isekaijoucho-', 'ヰ世界情緒 (Isekaijoucho)', 'ヰ世界情緒（Isekaijoucho）', 'ヰ世界情緒(Isekaijoucho)', 'ヰ世界情緒 －Isekaijoucho－',
        'ヰ世界情緒（Ｉｓｅｋａｉｊｏｕｃｈｏ）', '  ヰ世界情緒   -Isekaijoucho- ', 'ヰ世界情緒 (Isekaijoucho)'.normalize('NFD')]) {
        assert.deepEqual(decoratedNameParts(name), ['ヰ世界情緒', 'Isekaijoucho'], name);
    }
    assert.deepEqual(decoratedNameParts('中島美嘉 (Mika Nakashima)'), ['中島美嘉', 'Mika Nakashima']);
    assert.deepEqual(decoratedNameParts('中島美嘉（Mika Nakashima）'), ['中島美嘉', 'Mika Nakashima']);
    assert.deepEqual(decoratedNameParts('Кино (Kino)'), ['Кино', 'Kino']);
    assert.deepEqual(decoratedNameParts('花譜 (KAF)'), ['花譜', 'KAF']);
    assert.deepEqual(decoratedNameParts('ヰ世界情緒 (Ise-kai Jo\'ucho & Co!)'), ['ヰ世界情緒', 'Ise-kai Jo\'ucho & Co!']);
    assert.deepEqual(decoratedNameParts('ヰ世界情緒 (Isekai Jo’ucho 2.0)'), ['ヰ世界情緒', 'Isekai Jo’ucho 2.0']);
    // Parts come back as read after NFKC, so a half-width kana first part is given in its full-width form.
    assert.deepEqual(decoratedNameParts('ｲｾｶｲ (Isekai)'), ['イセカイ', 'Isekai']);
});

test('a disambiguation, a romanized first part, a part in two scripts, a placeholder part or another bracket is no decorated name', () => {
    for (const name of ['Queen (UK)', 'YUKI (JUDY AND MARY)', 'Prince (musician)', 'SawanoHiroyuki[nZk]', 'Björk (Bjork)', '周杰倫 (周杰伦)', 'μ\'s (ミューズ)',
        'Synthetic Song (Live)', 'ヰ世界情緒', 'A (B) (C)', 'ヰ世界情緒 (A) (B)', '鹿目まどか (CV: 悠木碧)', '鹿目まどか (CV: Yuuki Aoi)', '鹿目まどか (悠木碧)',
        'ヰ世界情緒 - Isekaijoucho -', 'ヰ世界情緒 -Isekai-joucho-', 'ヰ世界情緒-Isekaijoucho-', 'Yoko Kanno (菅野よう子)', 'ClariS (クラリス)', '(Isekaijoucho)',
        'ヰ世界情緒 ()', 'ヰ世界情緒 (2023)', 'ヴァリアス (Various Artists)', '不明 (unknown)', 'ヰ世界情緒 [Isekaijoucho]', 'ヰ世界情緒【Isekaijoucho】',
        'ヰ世界情緒 ～Isekaijoucho～', '!! (Isekaijoucho)', `合成${'情'.repeat(185)} (Isekaijoucho)`]) {
        assert.equal(decoratedNameParts(name), null, name);
    }
    for (const value of [7, null, undefined, ['ヰ世界情緒 (Isekaijoucho)'], { name: 'ヰ世界情緒 (Isekaijoucho)' }]) assert.equal(decoratedNameParts(value), null, String(value));
});

test('a saved Album title loses a trailing slash ending equal to a primary Artist name or a part of a decorated one', () => {
    for (const [title, names, expected] of [
        ['雪の華15周年記念ベスト盤 BIBLE／中島美嘉', ['中島美嘉'], '雪の華15周年記念ベスト盤 BIBLE'],
        ['Hits / Eagles', ['Eagles'], 'Hits'],
        // The shortest matching ending counts, so a name holding a slash is still found.
        ['Back in Black/AC/DC', ['AC/DC'], 'Back in Black'],
        ['Hits／ＥＡＧＬＥＳ', ['Eagles'], 'Hits'],
        ['Hits /  eagles ', ['Eagles'], 'Hits'],
        ['CANDY LIVE 2／ヰ世界情緒', ['ヰ世界情緒 -Isekaijoucho-'], 'CANDY LIVE 2'],
        ['CANDY LIVE 2/Isekaijoucho', ['ヰ世界情緒 -Isekaijoucho-'], 'CANDY LIVE 2'],
        ['CANDY LIVE 2/ヰ世界情緒 -Isekaijoucho-', ['ヰ世界情緒 -Isekaijoucho-'], 'CANDY LIVE 2'],
        ['Hits / Eagles', ['Various Artists', 'Eagles'], 'Hits'],
        ['Hits/Eagles/Eagles', ['Eagles'], 'Hits/Eagles'],
        ['中島美嘉／中島美嘉', ['中島美嘉'], '中島美嘉']
    ] as const) assert.equal(titleWithoutTrailingCredit(title, names), expected, title);
    for (const [title, names] of [
        // A label is no primary Artist name, nothing may be left before the slash, and the name must end the title.
        ['Best／Aniplex', ['ClariS']], ['／中島美嘉', ['中島美嘉']], ['!!／中島美嘉', ['中島美嘉']], ['雪の華／中島美嘉 Live', ['中島美嘉']],
        ['CANDY LIVE 2', ['ヰ世界情緒 -Isekaijoucho-']], ['Hits / Eagles', []], ['Hits / Eagles', [7, null]], [7, ['Eagles']], ['Hits / Eagles', null],
        [`${'a'.repeat(195)}/Eagles`, ['Eagles']]
    ] as const) assert.equal(titleWithoutTrailingCredit(title, names as never), null, String(title));
});
