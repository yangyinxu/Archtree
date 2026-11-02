import assert from 'node:assert/strict';
import test from 'node:test';
import { ObjectId } from 'mongodb';
import { adminCatalogItemRevision, adminCatalogSnapshot } from '../../src/administration/catalog/adminCatalogService';

const trackId = '5f1b0000000000000000b401';
/** No Album reference keeps these allowlisted snapshot checks independent of persistence. */
const track = (extra: Record<string, unknown> = {}) => ({
    _id: new ObjectId(trackId), title: 'Synthetic media', uploadStatus: 'ready', publicationStatus: 'ready',
    s3Key: trackId, ...extra
});

test('administrator MediaTrack snapshots identify Video and pre-migration Audio outside editable fields', async () => {
    for (const mediaType of [undefined, null, 'audio']) {
        const item = await adminCatalogSnapshot('audioTrack', track({ mediaType }), undefined as never);
        assert.equal(item.mediaType, 'audio');
        assert.equal('mediaType' in item.fields, false);
    }
    const item = await adminCatalogSnapshot('audioTrack', track({ mediaType: 'video', s3Key: `video/${trackId}/5f1b0000000000000000b402` }), undefined as never);
    assert.equal(item.mediaType, 'video');
    assert.equal(item.mediaUrl, `/api/admin/v1/catalog/audioTrack/${trackId}/media`);
    assert.equal('mediaType' in item.fields, false);
    assert.equal('s3Key' in item, false);
    const migrated = await adminCatalogSnapshot('audioTrack', track({ videoAsset: { active: {
        status: 'ready', contentType: 'video/mp4', byteLength: 100, s3Key: `video/${trackId}/5f1b0000000000000000b402`
    } } }), undefined as never);
    assert.equal(migrated.mediaType, 'video', 'legacy active Video follows the canonical delivery kind');
});

test('administrator Album, Artist and Organization snapshots do not acquire a media kind', async () => {
    for (const kind of ['album', 'artist', 'organization'] as const) {
        const item = await adminCatalogSnapshot(kind, { ...track(), mediaType: 'video', name: 'Synthetic name' }, undefined as never);
        assert.equal('mediaType' in item, false);
        assert.equal(item.mediaUrl, null);
    }
});

test('a Video frame revision changes with its active object identity even when metadata is unchanged', () => {
    const objectKey = `video/${trackId}/5f1b0000000000000000b402`;
    const representation = { revision: `mr_${'a'.repeat(32)}`, objectKey, byteLength: 100, etag: '"synthetic-first"', versionId: null };
    const original = track({ mediaType: 'video', s3Key: objectKey, contentType: 'video/mp4', mediaRepresentation: representation });
    const initial = adminCatalogItemRevision('audioTrack', original);
    for (const update of [
        { s3Key: `video/${trackId}/5f1b0000000000000000b403` },
        { mediaType: 'audio', s3Key: trackId },
        ...Object.entries({ revision: `mr_${'b'.repeat(32)}`, objectKey: `video/${trackId}/5f1b0000000000000000b403`, byteLength: 101, etag: '"synthetic-second"', versionId: 'next-version' })
            .map(([key, value]) => ({ mediaRepresentation: { ...representation, [key]: value } }))
    ]) assert.notEqual(adminCatalogItemRevision('audioTrack', { ...original, ...update }), initial);
    const itemRevision = adminCatalogItemRevision('audioTrack', { ...original, mediaByteHash: { value: 'private-evidence' } });
    assert.equal(itemRevision, initial, 'unrelated evidence does not drift a media approval');
});
