import assert from 'node:assert/strict';
import test from 'node:test';
import { isPublicCatalogVisibility, preserveCatalogVisibilityUpdate } from '../src/services/catalogVisibilityService';
import { toPublicPage } from '../src/services/publicPageService';
import { resolveReadyMediaTrackAsset } from '../src/controllers/mediaTrackController';
import { resolveReadyVideoAsset } from '../src/controllers/soundtrackVideoController';
import { getCoverArtObject, resolvePublicCoverArtAsset } from '../src/services/imageStorageService';

const id = '507f1f77bcf86cd799439011';

test('legacy omitted visibility is public; malformed and hidden values fail closed', () => {
    for (const row of [{}, { visibility: 'public' }]) assert.equal(isPublicCatalogVisibility(row), true);
    for (const value of ['hidden', undefined, null, '', 'PUBLIC', ['public'], {}, false]) {
        assert.equal(isPublicCatalogVisibility({ visibility: value }), false);
    }
    for (const value of [null, [], 'public']) assert.equal(isPublicCatalogVisibility(value), false);
});

test('legacy metadata adapters preserve omission and reject alternate visibility writes', () => {
    const update = { title: 'Changed title' };
    assert.equal(preserveCatalogVisibilityUpdate(update), update);
    for (const update of [{ visibility: 'hidden' }, { visibility: 'public' }, { 'visibility.value': 'public' }]) {
        assert.throws(() => preserveCatalogVisibilityUpdate(update), { code: 'catalog_visibility_operation_required' });
    }
});

test('one hidden Page occurrence does not hide its shared definition at a public placement', () => {
    const items = [
        { itemId: id, itemType: 'carousel', carouselId: id, visibility: 'hidden', order: 0 },
        { itemId: '507f1f77bcf86cd799439012', itemType: 'carousel', carouselId: id, order: 1 },
        { itemId: '507f1f77bcf86cd799439013', itemType: 'carousel', carouselId: id, visibility: ['public'], order: 2 }
    ];
    assert.deepEqual(toPublicPage({ slug: 'home', items }).items, [{
        itemId: items[1].itemId, itemType: 'carousel', carouselId: id, order: 0
    }]);
    assert.equal(items[0].visibility, 'hidden');
});

test('hidden media is rejected before object metadata, including injected alternate resolvers', async () => {
    const track = { _id: id, visibility: 'hidden', uploadStatus: 'ready', s3Key: id };
    let headCalls = 0;
    const dependencies = { findReadyTrack: async () => track, headObject: async () => { headCalls += 1; return {}; } };
    const signal = new AbortController().signal;
    assert.equal((await resolveReadyMediaTrackAsset(id, signal, dependencies)).status, 'notFound');
    assert.equal((await resolveReadyVideoAsset(id, signal, dependencies)).status, 'notFound');
    assert.equal(headCalls, 0);
});

test('hidden attached artwork is unavailable before storage and derivative-cache access', async () => {
    const asset = { ownerType: 'artist', ownerId: id, uploadStatus: 'ready', s3Key: `images/${id}` };
    const result = await resolvePublicCoverArtAsset(id, {
        findAsset: async () => asset,
        findOwner: async () => ({ coverArtId: id, lifecycleStatus: 'ready', visibility: 'hidden' })
    });
    assert.equal(result, null);
});

test('visibility revoked during metadata I/O suppresses media validators and bytes', async () => {
    const track = { _id: id, visibility: 'public', uploadStatus: 'ready', s3Key: id };
    let publicRead = true;
    const result = await resolveReadyMediaTrackAsset(id, new AbortController().signal, {
        findReadyTrack: async () => publicRead ? track : null,
        headObject: async () => { publicRead = false; return { ContentLength: 128, ETag: '"private"' }; }
    });
    assert.deepEqual(result, { status: 'notFound' });
});

test('visibility revoked during conditional artwork I/O cannot return a previous 304 validator', async () => {
    let visible = true;
    const result = await getCoverArtObject(id, { ifNoneMatch: '"old-image"' }, {
        findAsset: async () => ({ ownerType: 'artist', ownerId: id, uploadStatus: 'ready', s3Key: `images/${id}` }),
        findOwner: async () => ({ coverArtId: id, lifecycleStatus: 'ready', visibility: visible ? 'public' : 'hidden' }),
        getObject: async () => {
            visible = false;
            throw { $metadata: { httpStatusCode: 304 }, $response: { headers: { etag: '"old-image"' } } };
        }
    });
    assert.equal(result, null);
});

test('active media authorization rejects hidden access, replacement keys, and pinned revisions', async () => {
    const key = `audio/${id}/507f1f77bcf86cd799439012`;
    const revision = `mr_${'1'.repeat(32)}`;
    const representation = { revision, objectKey: key, etag: '"v1"', versionId: null, byteLength: 128 };
    let current: any = { _id: id, mediaType: 'audio', uploadStatus: 'ready', publicationStatus: 'ready', s3Key: key, mediaRepresentation: representation };
    const queries: (number | undefined)[] = [];
    const result = await resolveReadyMediaTrackAsset(id, new AbortController().signal, {
        findReadyTrack: async (_id, timeout) => { queries.push(timeout); return current; },
        headObject: async () => ({ ContentLength: 128, ETag: '"v1"' })
    }, undefined, revision);
    assert.equal(result.status, 'ready');
    if (result.status !== 'ready') return;
    assert.equal(await result.authorize(), true);
    const original = current;
    for (const changed of [
        null,
        { ...original, visibility: 'hidden' },
        { ...original, s3Key: id },
        { ...original, mediaRepresentation: { ...representation, revision: `mr_${'2'.repeat(32)}` } },
        { ...original, mediaRepresentation: { ...representation, etag: '"replacement"' } }
    ]) {
        current = changed;
        assert.equal(await result.authorize(), false);
    }
    assert.ok(queries.slice(2).every(timeout => timeout === 500));
});

test('legacy soundtrack authorization rejects a newly selected video key', async () => {
    const key = `video/${id}/507f1f77bcf86cd799439012`;
    let current: any = { _id: id, mediaType: 'video', contentType: 'video/mp4', uploadStatus: 'ready', s3Key: key };
    const result = await resolveReadyVideoAsset(id, new AbortController().signal, {
        findReadyTrack: async () => current,
        headObject: async () => ({ ContentLength: 128 })
    });
    assert.equal(result.status, 'ready');
    if (result.status !== 'ready') return;
    assert.equal(await result.authorize(), true);
    current = { ...current, s3Key: `video/${id}/507f1f77bcf86cd799439013` };
    assert.equal(await result.authorize(), false);
});

test('artwork stream authorization binds current owner, attachment and stored object version', async () => {
    const original = { ownerType: 'artist', ownerId: id, uploadStatus: 'ready', s3Key: `images/${id}`, storageIdentity: { etag: '"v1"', versionId: 'v1' } };
    let asset: any = original;
    let owner: any = { coverArtId: id, lifecycleStatus: 'ready' };
    const result = await getCoverArtObject(id, {}, {
        findAsset: async () => asset,
        findOwner: async () => owner,
        getObject: async () => ({ Body: null })
    });
    assert.ok(result && !result.notModified);
    if (!result || result.notModified) return;
    assert.equal(await result.authorize(), true);
    owner = { ...owner, visibility: 'hidden' };
    assert.equal(await result.authorize(), false);
    owner = { coverArtId: id, lifecycleStatus: 'ready' };
    asset = { ...original, ownerId: '507f1f77bcf86cd799439099' };
    assert.equal(await result.authorize(), false);
    asset = { ...original, storageIdentity: { etag: '"v2"', versionId: 'v2' } };
    assert.equal(await result.authorize(), false);
    asset = original;
    owner = { ...owner, coverArtId: '507f1f77bcf86cd799439099' };
    assert.equal(await result.authorize(), false);
});
