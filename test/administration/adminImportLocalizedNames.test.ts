/**
 * iTunes localized names of import Artist entries without a database (adminImportLocalizedNames.ts): which stored or found groups
 * an import keeps (only those holding a current entry name, distinct, bounded and clean), which an existing-Album review keeps
 * (also those naming a member's entry, within its identity bound), and the other names each name has through them for identity
 * candidates. All names are synthetic.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ImportDraftV2 } from '../../src/administration/import/adminImportDraft';
import { IMPORT_LOCALIZED_NAME_LIMITS, cleanLocalizedName, importLocalizedNameMap, mergeImportLocalizedNames } from '../../src/administration/import/adminImportLocalizedNames';
import { REVIEW_LOOKUP_LIMITS } from '../../src/administration/lookup/lookupReviewValues';

const draft = (...names: string[]) => ({ album: { title: '', artists: names.map((name, index) => ({ key: `00000009-0000-4000-a000-00000000000${index}`, name, role: 'primary', joinPhrase: null,
    musicBrainzId: null })), label: { name: 'Synthetic Records', musicBrainzId: null }, releaseDate: null, visibility: 'public' }, tracks: [] }) as unknown as ImportDraftV2;

test('an import keeps the localized name groups that hold a current Artist entry name, stored first, distinct by folded names, clean and bounded', () => {
    const merged = mergeImportLocalizedNames([['Isekaijoucho', 'ヰ世界情緒']], [['ISEKAIJOUCHO', 'ヰ世界情緒'], ['Eagles', 'イーグルス'], ['Synthetic Records', 'シンセレコード'], ['Unrelated', 'Other']],
        draft('ヰ世界情緒', 'eagles'));
    assert.deepEqual(merged, [['Isekaijoucho', 'ヰ世界情緒'], ['Eagles', 'イーグルス']]);
    // A label has no localized names, and a group left without an entry's name is dropped.
    assert.deepEqual(mergeImportLocalizedNames(merged, [], draft('Someone Else')), []);
    // Names are cleaned (NFC, trimmed), repeated folded names kept once, invisible or over-long ones dropped; a group needs two.
    const cleaned = mergeImportLocalizedNames([[' Isekaijoucho ', 'isekaijoucho', 'ヰ世界情緒', 'Bad\u200bName', 'x'.repeat(201), 'Fifth', 'Sixth', 'Seventh']], [], draft('Isekaijoucho'));
    assert.deepEqual(cleaned, [['Isekaijoucho', 'ヰ世界情緒', 'Fifth', 'Sixth']]);
    assert.equal(cleaned[0].length, IMPORT_LOCALIZED_NAME_LIMITS.names);
    assert.deepEqual(mergeImportLocalizedNames([['Only']], [['Only', 'only']], draft('Only')), []);
    // Malformed stored or found values read as none; at most 21 groups are kept.
    assert.deepEqual(mergeImportLocalizedNames('x', [7 as never, ['a']], draft('a')), []);
    const many = Array.from({ length: 30 }, (_unused, index) => [`Name ${index}`, `名 ${index}`]);
    assert.equal(mergeImportLocalizedNames(many, [], draft(...many.map(group => group[0]))).length, IMPORT_LOCALIZED_NAME_LIMITS.groups);
    assert.deepEqual([cleanLocalizedName(' A '), cleanLocalizedName(''), cleanLocalizedName(7), cleanLocalizedName('a\u0000b')], ['A', null, null, null]);
});

test('each name read gets the other names of every group holding it, never itself, and only the names read when given', () => {
    const stored = [['Isekaijoucho', 'ヰ世界情緒'], ['ヰ世界情緒', 'Isekai Joucho'], ['Eagles', 'イーグルス']];
    const map = importLocalizedNameMap(stored, ['ISEKAIJOUCHO', 'ヰ世界情緒']);
    assert.deepEqual([...map], [['isekaijoucho', ['ヰ世界情緒']], ['ヰ世界情緒', ['Isekaijoucho', 'Isekai Joucho']]]);
    assert.deepEqual([...importLocalizedNameMap(stored)].map(([name]) => name), ['isekaijoucho', 'ヰ世界情緒', 'isekai joucho', 'eagles', 'イーグルス']);
    assert.deepEqual([...importLocalizedNameMap(null, ['a']), ...importLocalizedNameMap([['a']], ['a'])], []);
});

test('a review also keeps the groups naming an artist only its members\' entries carry, up to one per identity, and reads them past the import bound', () => {
    const memberDraft = (names: string[]) => ({ ...draft('Synthetic Ensemble'), tracks: names.map((name, index) => ({ slotId: `00000009-0000-4000-b000-${String(index).padStart(12, '0')}`,
        title: '', discNumber: null, trackNumber: null, artists: [{ key: `00000009-0000-4000-c000-${String(index).padStart(12, '0')}`, name, role: 'primary', joinPhrase: null, musicBrainzId: null }] })) }) as unknown as ImportDraftV2;
    const found = [['Synthetic Singer', 'シンセ シンガー'], ['Unrelated', 'Other']];
    assert.deepEqual([mergeImportLocalizedNames([], found, memberDraft(['Synthetic Singer']), { review: true }), mergeImportLocalizedNames([], found, memberDraft(['Synthetic Singer']))],
        [[['Synthetic Singer', 'シンセ シンガー']], []]);
    // A malformed member list carries no name.
    const malformed = { ...memberDraft([]), tracks: [{ slotId: 'x', artists: 'bad' }, null] } as unknown as ImportDraftV2;
    assert.deepEqual(mergeImportLocalizedNames([], found, malformed, { review: true }), []);
    const many = Array.from({ length: REVIEW_LOOKUP_LIMITS.identities + 5 }, (_unused, index) => [`Singer ${index}`, `歌手 ${index}`]);
    const kept = mergeImportLocalizedNames(many, [], memberDraft(many.map(group => group[0])), { review: true });
    assert.equal(kept.length, REVIEW_LOOKUP_LIMITS.identities);
    assert.deepEqual([importLocalizedNameMap(kept, ['Singer 100'], { review: true }).get('singer 100'), importLocalizedNameMap(kept, ['Singer 100']).get('singer 100')], [['歌手 100'], undefined]);
});
