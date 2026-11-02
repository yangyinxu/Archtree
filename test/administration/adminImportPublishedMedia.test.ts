/**
 * The shared byte proof that a published Track still holds exactly the file an import staged for it, as local MP3 conversion and
 * existing-Album review evidence both check it, without a database. All identifiers are synthetic.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ObjectId } from 'mongodb';
import { publishedImportMedia } from '../../src/administration/import/adminImportPublishedMedia';
import { CONVERSION_MAX_BYTES } from '../../src/administration/conversion/conversionContract';

const trackId = '0000000000000000000b0001', otherId = '0000000000000000000b0002';
const key = `audio/${trackId}/0000000000000000000f0001`, sha256 = 'a'.repeat(64), byteLength = 4_096, etag = '"synthetic-etag"', versionId = 'synthetic-version';
const asset = { slotId: '0000000b-0000-4000-a000-000000000001', state: 'ready', sha256, byteLength };
/** A FLAC Track holding the staged file, with `changes` applied (a nested object replaces that part). */
const track = (changes: Record<string, unknown> = {}) => ({
    _id: new ObjectId(trackId), mediaType: 'audio', s3Key: key, contentType: 'audio/flac',
    mediaByteHash: { algorithm: 'sha256', value: sha256, byteLength, objectKey: key, etag, versionId },
    mediaRepresentation: { objectKey: key, etag, versionId, byteLength, durationMs: 200_000 }, ...changes
});
const hash = (changes: Record<string, unknown>) => ({ mediaByteHash: { ...track().mediaByteHash, ...changes } });
const representation = (changes: Record<string, unknown>) => ({ mediaRepresentation: { ...track().mediaRepresentation, ...changes } });

test('a Track that still holds the staged file passes with any audio type by default and returns its proof', () => {
    assert.deepEqual(publishedImportMedia(trackId, asset, track()), { sha256, byteLength, key, etag, versionId });
    assert.deepEqual(publishedImportMedia(trackId, { ...asset, state: 'deleted' }, track({ contentType: 'audio/mpeg' }))?.key, key);
    // A legacy root key and an unversioned object still prove.
    const root = { s3Key: trackId, ...hash({ objectKey: trackId, versionId: null }), ...representation({ objectKey: trackId, versionId: null }) };
    assert.deepEqual(publishedImportMedia(trackId, asset, track(root)), { sha256, byteLength, key: trackId, etag, versionId: null });
});

test('any byte, key, etag, version, length or type disagreement breaks the proof', () => {
    const cases: [string, unknown, unknown][] = [
        ['hash value', asset, track(hash({ value: 'b'.repeat(64) }))],
        ['asset hash', { ...asset, sha256: 'b'.repeat(64) }, track()],
        ['malformed hash', { ...asset, sha256: 'A'.repeat(64) }, track(hash({ value: 'A'.repeat(64) }))],
        ['hash algorithm', asset, track(hash({ algorithm: 'md5' }))],
        ['byte length', { ...asset, byteLength: byteLength + 1 }, track()],
        ['zero length', { ...asset, byteLength: 0 }, track({ ...hash({ byteLength: 0 }), ...representation({ byteLength: 0 }) })],
        ['hash object key', asset, track(hash({ objectKey: `audio/${trackId}/0000000000000000000f0002` }))],
        ['representation key', asset, track(representation({ objectKey: `audio/${trackId}/0000000000000000000f0002` }))],
        ['etag disagreement', asset, track(representation({ etag: '"other-etag"' }))],
        ['malformed etag', asset, track({ ...hash({ etag: 'unquoted' }), ...representation({ etag: 'unquoted' }) })],
        ['version with a newline', asset, track({ ...hash({ versionId: 'a\nb' }), ...representation({ versionId: 'a\nb' }) })],
        ['over-long version', asset, track({ ...hash({ versionId: 'v'.repeat(1025) }), ...representation({ versionId: 'v'.repeat(1025) }) })],
        ['empty version', asset, track({ ...hash({ versionId: '' }), ...representation({ versionId: '' }) })],
        ['version disagreement', asset, track(representation({ versionId: 'other-version' }))],
        ['representation length', asset, track(representation({ byteLength: byteLength - 1 }))],
        ['missing representation', asset, track({ mediaRepresentation: null })],
        ['missing hash', asset, track({ mediaByteHash: null })],
        ['video media type', asset, track({ mediaType: 'video' })],
        ['key of another Track', asset, track({ s3Key: `audio/${otherId}/0000000000000000000f0001` })],
        ['non-audio content type', asset, track({ contentType: 'video/mp4' })],
        ['missing content type', asset, track({ contentType: undefined })],
        ['missing asset', undefined, track()],
        ['missing Track', asset, undefined],
        ['malformed values', 'asset', 'track']
    ];
    for (const [name, staged, current] of cases) assert.equal(publishedImportMedia(trackId, staged, current), null, name);
    // The proof is for the Track it names.
    assert.equal(publishedImportMedia(otherId, asset, track()), null);
});

test('conversion options accept only an MP3 within its byte cap', () => {
    const mp3 = { contentType: (value: unknown) => value === 'audio/mpeg', maxBytes: CONVERSION_MAX_BYTES };
    assert.equal(publishedImportMedia(trackId, asset, track(), mp3), null);
    assert.equal(publishedImportMedia(trackId, asset, track({ contentType: 'audio/mpeg' }), mp3)?.sha256, sha256);
    const over = CONVERSION_MAX_BYTES + 1;
    const large = track({ contentType: 'audio/mpeg', ...hash({ byteLength: over }), ...representation({ byteLength: over }) });
    assert.equal(publishedImportMedia(trackId, { ...asset, byteLength: over }, large, mp3), null);
    assert.equal(publishedImportMedia(trackId, { ...asset, byteLength: over }, large)?.byteLength, over);
});
