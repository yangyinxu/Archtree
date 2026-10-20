/**
 * The pure Credit builders of an import publication: a new Album's Credits in draft order with the label last, its Tracks'
 * primary Credits (a phrase kept only before another primary), and an appended Track's inherited Credits. All identities and names are synthetic.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
// The database module loads first; importing adminImportService (through the commit module) before it trips the index import cycle.
import '../../src/infrastructure/database';
import { AdminImportError } from '../../src/administration/import/adminImportContract';
import { importAlbumCredits, importAppendedTrackCredits, importNewAlbumTrackCredits } from '../../src/administration/import/adminImportCatalogCommit';
import type { ImportArtistEntry } from '../../src/administration/import/adminImportDraft';
import type { ImportPublicationArtist } from '../../src/administration/import/adminImportMediaTypes';
import { CatalogCreditValidationError, legacyTrackArtistIdsFromCredits, normalizeCatalogCredits } from '../../src/models/catalogCredit';

const key = (n: number) => `00000009-0000-4000-8000-${String(n).padStart(12, '0')}`;
const id = (n: number) => `64b${String(n).padStart(21, '0')}`;
const entry = (n: number, name: string, role: 'primary' | 'featured', joinPhrase: string | null = null): ImportArtistEntry => ({ key: key(n), name, role, joinPhrase, musicBrainzId: null });
const frozen = (n: number, newArtist = true): ImportPublicationArtist => ({ entryKey: key(n), artistId: id(n), newArtist, candidateRevision: newArtist ? null : 'r'.repeat(64) });
const entries = [entry(1, 'Lorem Ensemble', 'primary', ' & '), entry(2, 'Ipsum Quartet', 'primary', ' feat. '), entry(3, 'Dolor Soloist', 'featured')];
const artists = [frozen(1), frozen(2, false), frozen(3)];
const label = { organizationId: id(9), newOrganization: true, candidateRevision: null };
const conflict = (error: unknown) => error instanceof AdminImportError && error.status === 409 && error.code === 'ADMIN_IMPORT_PUBLICATION_CONFLICT';

test('a new Album credits each entry in draft order with its role and join phrase, then the label as an Organization label Credit', () => {
    assert.deepEqual(importAlbumCredits(entries, artists, label), [
        { creditId: `import_primary_${id(1)}`, subjectType: 'artist', subjectId: id(1), role: 'primary', order: 0, joinPhrase: ' & ' },
        { creditId: `import_primary_${id(2)}`, subjectType: 'artist', subjectId: id(2), role: 'primary', order: 1, joinPhrase: ' feat. ' },
        { creditId: `import_featured_${id(3)}`, subjectType: 'artist', subjectId: id(3), role: 'featured', order: 2 },
        { creditId: `import_label_${id(9)}`, subjectType: 'organization', subjectId: id(9), role: 'label', order: 3 }
    ]);
    // Without a label there is no label Credit.
    assert.deepEqual(importAlbumCredits(entries, artists, null).map(credit => credit.role), ['primary', 'primary', 'featured']);
});

test('a new Album\'s Tracks receive only its primary Credits, in order, keeping a phrase only before another primary', () => {
    const album = importAlbumCredits(entries, artists, label), tracks = importNewAlbumTrackCredits(album);
    // ' feat. ' led into the featured Artist, who stays on the Album, so the Track does not store it.
    assert.deepEqual(tracks, [
        { creditId: `import_primary_${id(1)}`, subjectType: 'artist', subjectId: id(1), role: 'primary', order: 0, joinPhrase: ' & ' },
        { creditId: `import_primary_${id(2)}`, subjectType: 'artist', subjectId: id(2), role: 'primary', order: 1 }
    ]);
    assert.equal(tracks.every(credit => !('joinPhrase' in credit) || credit.joinPhrase !== undefined), true, 'an absent phrase is omitted, never undefined');
    assert.deepEqual(legacyTrackArtistIdsFromCredits(tracks), [id(1), id(2)]);
    // A primary after a featured entry keeps its phrase before the next primary; the last primary's phrase before the label goes.
    const interleaved = importAlbumCredits([entry(1, 'Lorem Ensemble', 'primary', ' with '), entry(3, 'Dolor Soloist', 'featured', ' & '), entry(2, 'Ipsum Quartet', 'primary', ' x '), entry(4, 'Sit Trio', 'primary', ' / ')],
        [frozen(1), frozen(3), frozen(2), frozen(4)], label);
    assert.deepEqual(importNewAlbumTrackCredits(interleaved).map(credit => [credit.subjectId, credit.joinPhrase]), [[id(1), undefined], [id(2), ' x '], [id(4), undefined]]);
});

test('a single primary entry writes the Album Credits a format-2 approval writes, and its Track keeps no trailing phrase', () => {
    const credit = { creditId: `import_primary_${id(1)}`, subjectType: 'artist', subjectId: id(1), role: 'primary', order: 0 };
    for (const joinPhrase of [null, ' & ']) {
        const format2 = normalizeCatalogCredits([{ ...credit, ...(joinPhrase ? { joinPhrase } : {}) }]);
        const album = importAlbumCredits([entry(1, 'Lorem Ensemble', 'primary', joinPhrase)], [frozen(1)], null);
        // Without a phrase the Track's Credits equal format 2's too; a phrase after the only primary is never shown and is not copied.
        assert.equal(JSON.stringify(album), JSON.stringify(format2)); assert.equal(JSON.stringify(importNewAlbumTrackCredits(album)), JSON.stringify(normalizeCatalogCredits([credit])));
    }
});

test('an appended Track inherits the target Album\'s primaries in its order and keeps a phrase only before another inherited Credit', () => {
    const target = [
        { creditId: 'album_primary_one', subjectType: 'artist', subjectId: id(1), role: 'primary', order: 0, joinPhrase: ' feat. ' },
        { creditId: 'album_featured_two', subjectType: 'artist', subjectId: id(2), role: 'featured', order: 1, joinPhrase: ' & ' },
        { creditId: 'album_primary_three', subjectType: 'artist', subjectId: id(3), role: 'primary', order: 2, joinPhrase: ' x ' },
        { creditId: 'album_primary_four', subjectType: 'artist', subjectId: id(4), role: 'primary', order: 3 },
        { creditId: 'album_label_five', subjectType: 'organization', subjectId: id(5), role: 'label', order: 4 }
    ];
    const credits = importAppendedTrackCredits(id(7), target);
    assert.deepEqual(credits.map(credit => [credit.subjectId, credit.role, credit.order, credit.joinPhrase]), [[id(1), 'primary', 0, undefined], [id(3), 'primary', 1, ' x '], [id(4), 'primary', 2, undefined]]);
    assert.equal(credits.every(credit => !('joinPhrase' in credit) || credit.joinPhrase !== undefined), true, 'an absent phrase is omitted, never undefined');
    assert.deepEqual(legacyTrackArtistIdsFromCredits(credits), [id(1), id(3), id(4)]);
    // Credit IDs are deterministic per Track, so a retried commit writes the same Credits.
    assert.deepEqual(importAppendedTrackCredits(id(7), target), credits); assert.notDeepEqual(importAppendedTrackCredits(id(8), target).map(credit => credit.creditId), credits.map(credit => credit.creditId));
});

test('frozen Artists that do not match the entries one to one are a catalog conflict, and an invalid phrase is refused by the Credit rules', () => {
    assert.throws(() => importAlbumCredits(entries, artists.slice(0, 2), label), conflict, 'a missing Artist');
    assert.throws(() => importAlbumCredits(entries, [artists[1], artists[0], artists[2]], label), conflict, 'another order');
    assert.throws(() => importAlbumCredits(entries.slice(0, 2), artists, null), conflict, 'an extra Artist');
    assert.throws(() => importAlbumCredits([entry(1, 'Lorem Ensemble', 'primary', '\u200B')], [frozen(1)], null), CatalogCreditValidationError);
    // Two entries frozen to one Artist would duplicate a subject and role.
    assert.throws(() => importAlbumCredits(entries.slice(0, 2), [frozen(1), { ...frozen(2), artistId: id(1) }], null), CatalogCreditValidationError);
});
