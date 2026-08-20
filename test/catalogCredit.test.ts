import assert from 'node:assert/strict';
import test from 'node:test';

import {
    CatalogCreditValidationError,
    classifyArtistAlbumCredit,
    legacyAlbumArtistIdsFromCredits,
    legacyTrackArtistIdsFromCredits,
    mergeLegacyArtistIdsIntoCredits,
    migratedCatalogCreditId,
    normalizeCatalogCredits,
    validateAttribution
} from '../src/models/catalogCredit';

const artistId = '64b000000000000000000001';
const featuredId = '64b000000000000000000002';
const organizationId = '64b000000000000000000003';

test('normalizes ordered Credits and preserves only valid legacy projections', () => {
    const credits = normalizeCatalogCredits([
        { creditId: 'credit_primary', subjectType: 'artist', subjectId: artistId.toUpperCase(), role: 'primary', order: 12 },
        { creditId: 'credit_featured', subjectType: 'artist', subjectId: featuredId, role: 'featured', order: 0 },
        { creditId: 'credit_label', subjectType: 'organization', subjectId: organizationId, role: 'label', order: 4 }
    ]);
    assert.deepEqual(credits.map((credit) => credit.order), [0, 1, 2]);
    assert.deepEqual(legacyTrackArtistIdsFromCredits(credits), [artistId, featuredId]);
    assert.deepEqual(legacyAlbumArtistIdsFromCredits(credits), [artistId]);
    assert.equal(validateAttribution('documented', credits), 'documented');
});

test('rejects invalid subject-role pairs, duplicates, and contradictory attribution', () => {
    assert.throws(() => normalizeCatalogCredits([
        { creditId: 'credit_invalid', subjectType: 'organization', subjectId: organizationId, role: 'primary', order: 0 }
    ]), CatalogCreditValidationError);
    assert.throws(() => normalizeCatalogCredits([
        { creditId: 'credit_first', subjectType: 'artist', subjectId: artistId, role: 'primary', order: 0 },
        { creditId: 'credit_second', subjectType: 'artist', subjectId: artistId, role: 'primary', order: 1 }
    ]), /Duplicate subject/);
    assert.throws(() => validateAttribution('documented', []), /requires at least one Credit/);
    assert.throws(() => validateAttribution('unknown', normalizeCatalogCredits([
        { creditId: 'credit_primary', subjectType: 'artist', subjectId: artistId, role: 'primary', order: 0 }
    ])), /cannot contain documented Credits/);
});

test('classifies one Artist Album relationship with deterministic precedence', () => {
    const primary = normalizeCatalogCredits([
        { creditId: 'credit_primary', subjectType: 'artist', subjectId: artistId, role: 'primary', order: 0 }
    ]);
    const featuredTrack = normalizeCatalogCredits([
        { creditId: 'credit_featured', subjectType: 'artist', subjectId: artistId, role: 'featured', order: 0 }
    ]);
    assert.equal(classifyArtistAlbumCredit(artistId, primary, featuredTrack), 'discography');
    assert.equal(classifyArtistAlbumCredit(artistId, [], featuredTrack), 'appearsOn');
    assert.equal(classifyArtistAlbumCredit(artistId, normalizeCatalogCredits([
        { creditId: 'credit_producer', subjectType: 'artist', subjectId: artistId, role: 'producer', order: 0 }
    ]), []), 'credits');
    assert.equal(classifyArtistAlbumCredit(featuredId, primary, featuredTrack), null);
});

test('migration Credit IDs are stable and intent-specific', () => {
    const first = migratedCatalogCreditId('album', '64b000000000000000000004', 'artist', artistId, 'primary');
    assert.equal(first, migratedCatalogCreditId('album', '64b000000000000000000004', 'artist', artistId, 'primary'));
    assert.notEqual(first, migratedCatalogCreditId('audioTrack', '64b000000000000000000004', 'artist', artistId, 'primary'));
});

test('legacy artist edits preserve known roles and Organization Credits', () => {
    const existing = normalizeCatalogCredits([
        { creditId: 'credit_primary', subjectType: 'artist', subjectId: artistId, role: 'primary' },
        { creditId: 'credit_removed', subjectType: 'artist', subjectId: featuredId, role: 'featured' },
        { creditId: 'credit_label', subjectType: 'organization', subjectId: organizationId, role: 'label' }
    ]);
    const addedId = '64b000000000000000000004';
    const merged = mergeLegacyArtistIdsIntoCredits(
        'audioTrack',
        '64b000000000000000000005',
        existing,
        [artistId, addedId]
    );
    assert.deepEqual(merged.map((credit) => [credit.subjectId, credit.role]), [
        [artistId, 'primary'],
        [addedId, 'legacyUnspecified'],
        [organizationId, 'label']
    ]);
});
