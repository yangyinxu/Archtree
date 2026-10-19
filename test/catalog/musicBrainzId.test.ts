import assert from 'node:assert/strict';
import test from 'node:test';
import {
    MUSICBRAINZ_ID_INDEX_NAMES, MUSICBRAINZ_SPECIAL_PURPOSE_ARTIST_IDS, MUSICBRAINZ_SPECIAL_PURPOSE_LABEL_IDS, isMusicBrainzIdDuplicateKey,
    isSpecialPurposeMusicBrainzId, keepableMusicBrainzId, musicBrainzIdPartialFilter, normalizeMusicBrainzId
} from '../../src/utils/musicBrainzId';
import { normalizeMusicBrainzId as lookupNormalize } from '../../src/administration/lookup/lookupIdentifiers';

const synthetic = '00000000-0000-4000-8000-000000000001';

test('MusicBrainz IDs are lowercase 8-4-4-4-12 hex UUIDs of any version, never the nil UUID', () => {
    assert.equal(normalizeMusicBrainzId(synthetic), synthetic);
    assert.equal(normalizeMusicBrainzId(synthetic.toUpperCase()), synthetic);
    // Real MusicBrainz IDs include version-3 UUIDs.
    assert.equal(normalizeMusicBrainzId('1d472dd6-32cc-3f0a-9a1b-000000000003'), '1d472dd6-32cc-3f0a-9a1b-000000000003');
    for (const value of ['00000000-0000-0000-0000-000000000000', `${synthetic} `, synthetic.slice(1), synthetic.replace(/-/g, ''), 'g0000000-0000-4000-8000-000000000001', 42, null, undefined, {}, [synthetic]]) {
        assert.equal(normalizeMusicBrainzId(value), null, String(value));
    }
    // Lookup keeps re-exporting the shared check.
    assert.equal(lookupNormalize, normalizeMusicBrainzId);
});

test('every documented special purpose artist and label is refused, as one blocklist for both kinds', () => {
    assert.equal(MUSICBRAINZ_SPECIAL_PURPOSE_ARTIST_IDS.length, 12);
    assert.equal(MUSICBRAINZ_SPECIAL_PURPOSE_LABEL_IDS.length, 3);
    for (const id of [...MUSICBRAINZ_SPECIAL_PURPOSE_ARTIST_IDS, ...MUSICBRAINZ_SPECIAL_PURPOSE_LABEL_IDS]) {
        assert.equal(normalizeMusicBrainzId(id), id, 'each listed ID is itself well formed');
        assert.equal(isSpecialPurposeMusicBrainzId(id), true);
        assert.equal(isSpecialPurposeMusicBrainzId(id.toUpperCase()), true);
        assert.equal(keepableMusicBrainzId(id), null);
        assert.equal(keepableMusicBrainzId(id.toUpperCase()), null);
    }
    assert.equal(keepableMusicBrainzId(synthetic.toUpperCase()), synthetic);
    assert.equal(keepableMusicBrainzId('not-an-id'), null);
});

test('only a duplicate key on a MusicBrainz ID index counts as an ID conflict', () => {
    assert.deepEqual(musicBrainzIdPartialFilter, { musicBrainzId: { $type: 'string' } });
    assert.equal(isMusicBrainzIdDuplicateKey({ code: 11000, keyPattern: { musicBrainzId: 1 } }), true);
    assert.equal(isMusicBrainzIdDuplicateKey({ code: 11000, message: `E11000 duplicate key error collection: db.artists index: ${MUSICBRAINZ_ID_INDEX_NAMES.artists} dup key` }), true);
    assert.equal(isMusicBrainzIdDuplicateKey({ code: 11000, message: `index: ${MUSICBRAINZ_ID_INDEX_NAMES.organizations}` }), true);
    assert.equal(isMusicBrainzIdDuplicateKey({ code: 11000, keyPattern: { _id: 1 }, message: 'index: _id_ dup key' }), false);
    assert.equal(isMusicBrainzIdDuplicateKey({ code: 112, keyPattern: { musicBrainzId: 1 } }), false);
    assert.equal(isMusicBrainzIdDuplicateKey(new Error('artist_musicbrainz_id')), false);
    assert.equal(isMusicBrainzIdDuplicateKey(null), false);
    assert.equal(isMusicBrainzIdDuplicateKey('E11000'), false);
});
