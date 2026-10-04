import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { ObjectId } from 'mongodb';
import { getDb } from '../src/infrastructure/database';
import { Carousel, type ArtistCarouselScope } from '../src/models/carousel';
import { getListenerArtist } from '../src/services/listenerContentService';
import { startMongoReplicaSet, type MongoReplicaSetHarness } from './support/mongoReplicaSet';

let harness: MongoReplicaSetHarness;
const artistId = new ObjectId();
const credit = (role: string) => ({ creditId: `credit_${role}`, subjectType: 'artist', subjectId: String(artistId), role, order: 0 });
before(async () => { harness = await startMongoReplicaSet('archtree-artist-carousel-classification-test'); });
after(async () => { await harness?.stop(); });
beforeEach(async () => {
    await Promise.all(['artists', 'albums', 'audioTracks'].map(name => getDb()!.collection(name).deleteMany({})));
    await getDb()!.collection('artists').insertOne({ _id: artistId, name: 'Artist', albumIds: [] });
});
const album = async (title: string, roles?: string[], lifecycleStatus = 'ready') => {
    const _id = new ObjectId();
    await getDb()!.collection('albums').insertOne({ _id, title, audioTrackIds: [], lifecycleStatus,
        ...(roles ? { credits: roles.map(credit), attributionStatus: roles.length ? 'documented' : 'unknown' } : {}) });
    return _id;
};
const track = async (albumId: ObjectId, roles?: string[], uploadStatus = 'ready') => {
    const _id = new ObjectId();
    await getDb()!.collection('audioTracks').insertOne({ _id, albumId, title: 'Track', artistIds: [String(artistId)],
        ...(roles ? { credits: roles.map(credit), attributionStatus: roles.length ? 'documented' : 'unknown' } : {}), uploadStatus, s3Key: String(_id) });
    return _id;
};
const resolve = async (scope: ArtistCarouselScope, limit = 20) => (await Carousel.resolveCarousel({ mode: 'artist', artistConfig: {
    artistId: String(artistId), contentType: 'album', scope, sort: 'titleAsc', limit
} })).items.map((entry: any) => entry.contentId);

test('Artist Album carousel filters lifecycle before its output limit', async () => {
    await album('A failed', ['primary'], 'failed');
    await album('B deleting', ['primary'], 'deleting');
    const ready = await album('C ready', ['primary']);
    assert.deepEqual(await resolve('discography', 1), [String(ready)]);
});

test('Artist page and all carousel scopes apply identical role precedence before limiting', async () => {
    const primary = await album('A primary', ['primary', 'featured']); await track(primary, ['performer']);
    const featured = await album('B featured', ['featured']); await track(featured, ['performer']);
    const composer = await album('C composition'); await track(composer, ['composer']);
    const appears = await album('D appears'); await track(appears, ['performer']);
    const mixed = await album('E mixed', ['composer']); await track(mixed, ['performer']);
    const pending = await album('F not ready participation'); await track(pending, ['performer'], 'pending');
    const expected = { discography: [String(primary)], collaborations: [String(featured)], appearsOn: [String(appears), String(mixed)], creditAlbums: [String(composer)] };
    const page = await getListenerArtist(String(artistId));
    for (const [section, ids] of Object.entries(expected)) assert.deepEqual(new Set(page![section as keyof typeof expected].map((entry: any) => entry.id)), new Set(ids));
    assert.deepEqual(await resolve('discography'), expected.discography);
    assert.deepEqual(await resolve('collaborations'), expected.collaborations);
    assert.deepEqual(await resolve('appearsOn'), expected.appearsOn);
    assert.deepEqual(await resolve('appearsOn', 1), [String(appears)]);
    assert.deepEqual(await resolve('allRelated'), [primary, featured, composer, appears, mixed].map(String));
});

test('Legacy membership applies only to unmigrated records, never canonical empty or malformed Credits', async () => {
    const legacy = await album('A legacy');
    const empty = await album('B empty', []);
    const malformed = await album('C invalid');
    await getDb()!.collection('albums').updateOne({ _id: malformed }, { $set: { credits: [{ role: 'primary' }] } });
    await getDb()!.collection('artists').updateOne({ _id: artistId }, { $set: { albumIds: [legacy, empty, malformed].map(String) } });
    const legacyTrack = await album('D legacy track'); await track(legacyTrack);
    const emptyTrack = await album('E empty track'); await track(emptyTrack, []);
    assert.deepEqual(await resolve('discography'), [String(legacy)]);
    assert.deepEqual(await resolve('appearsOn'), [String(legacyTrack)]);
    const page = await getListenerArtist(String(artistId));
    assert.deepEqual(page!.discography.map(entry => entry.id), [String(legacy)]);
    assert.deepEqual(page!.appearsOn.map(entry => entry.id), [String(legacyTrack)]);
});

test('partial Credit migration keeps legacy Album primary precedence and legacy track participation precedence', async () => {
    const legacyPerformer = await album('A legacy primary with canonical performer'); await track(legacyPerformer, ['performer']);
    const legacyComposer = await album('B legacy primary with canonical composer'); await track(legacyComposer, ['composer']);
    const albumComposer = await album('C canonical composer with legacy track'); await track(albumComposer);
    await getDb()!.collection('albums').updateOne({ _id: albumComposer }, {
        $set: { credits: [credit('composer')], attributionStatus: 'documented' }
    });
    const featured = await album('D canonical featured with legacy track', ['featured']); await track(featured);
    await getDb()!.collection('artists').updateOne({ _id: artistId }, {
        $set: { albumIds: [legacyPerformer, legacyComposer, albumComposer, featured].map(String) }
    });
    assert.deepEqual(await resolve('discography'), [legacyPerformer, legacyComposer].map(String));
    assert.deepEqual(await resolve('appearsOn'), [String(albumComposer)]);
    assert.deepEqual(await resolve('collaborations'), [String(featured)]);
    const page = await getListenerArtist(String(artistId));
    assert.deepEqual(page!.discography.map(entry => entry.id), [legacyPerformer, legacyComposer].map(String));
    assert.deepEqual(page!.appearsOn.map(entry => entry.id), [String(albumComposer)]);
    assert.deepEqual(page!.collaborations.map(entry => entry.id), [String(featured)]);
    assert.deepEqual(page!.creditAlbums, []);
});

test('legacy uppercase relationship IDs resolve identically in Artist pages and Album carousels', async () => {
    const canonicalTrackAlbum = await album('A uppercase Album link');
    const canonicalTrack = await track(canonicalTrackAlbum, ['performer']);
    await getDb()!.collection('audioTracks').updateOne({ _id: canonicalTrack }, { $set: { albumId: String(canonicalTrackAlbum).toUpperCase() } });
    const legacyTrackAlbum = await album('B uppercase Artist link');
    const legacyTrack = await track(legacyTrackAlbum);
    await getDb()!.collection('audioTracks').updateOne({ _id: legacyTrack }, { $set: { artistIds: [String(artistId).toUpperCase()] } });
    const expected = [canonicalTrackAlbum, legacyTrackAlbum].map(String);
    assert.deepEqual((await getListenerArtist(String(artistId)))!.appearsOn.map(entry => entry.id), expected);
    assert.deepEqual(await resolve('appearsOn'), expected);
});

for (const rolloutFlag of ['CATALOG_CREDIT_SECTIONS_ENABLED', 'CATALOG_CREDIT_READS_ENABLED']) {
test(`Disabling ${rolloutFlag} restores the same legacy fallback on Artist pages and carousels`, async () => {
    const primary = await album('A primary', ['primary']);
    const legacy = await album('B legacy', []);
    await getDb()!.collection('artists').updateOne({ _id: artistId }, { $set: { albumIds: [String(legacy)] } });
    const previous = process.env[rolloutFlag];
    process.env[rolloutFlag] = 'false';
    try {
        assert.deepEqual(await resolve('discography'), [String(legacy)]);
        assert.deepEqual(await resolve('allRelated'), [String(legacy)]);
        assert.deepEqual((await getListenerArtist(String(artistId)))!.discography.map(entry => entry.id), [String(legacy)]);
    } finally {
        if (previous === undefined) delete process.env[rolloutFlag];
        else process.env[rolloutFlag] = previous;
    }
    assert.deepEqual(await resolve('discography'), [String(primary)]);
});
}

test('A prolific first release cannot hide later releases behind the old 2000-track cutoff', async () => {
    const first = await album('A prolific');
    const last = await album('Z later');
    await getDb()!.collection('audioTracks').insertMany(Array.from({ length: 2_001 }, () => {
        const _id = new ObjectId();
        return { _id, albumId: first, title: 'Track', credits: [credit('performer')], attributionStatus: 'documented', uploadStatus: 'ready', s3Key: String(_id) };
    }));
    await track(last, ['performer']);
    assert.deepEqual(await resolve('appearsOn'), [String(first), String(last)]);
});
