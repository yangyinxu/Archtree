import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { ObjectId } from 'mongodb';

import { getDb } from '../src/infrastructure/database';
import { Album } from '../src/models/album';
import { Artist } from '../src/models/artist';
import { AudioFormat, AudioTrack } from '../src/models/audioTrack';
import { SimpleDate } from '../src/models/simpleDate';
import {
    getPublicAlbum,
    getPublicArtist,
    listPublicAlbums,
    listPublicArtists
} from '../src/services/publicCatalogService';
import {
    MongoReplicaSetHarness,
    startMongoReplicaSet
} from './support/mongoReplicaSet';

let harness: MongoReplicaSetHarness | undefined;
let creatorUserId = '';

before(async () => {
    harness = await startMongoReplicaSet('archtree-catalog-create-publication-test');
});

beforeEach(async () => {
    await Promise.all([
        'albums',
        'artists',
        'audioTracks',
        'imageAssets',
        'organizations',
        'users'
    ].map((collection) => getDb()!.collection(collection).deleteMany({})));
    const creatorId = new ObjectId();
    creatorUserId = creatorId.toHexString();
    await getDb()!.collection('users').insertOne({
        _id: creatorId,
        email: `${creatorUserId}@example.com`,
        role: 'admin'
    });
});

after(async () => {
    await harness?.stop();
});

test('uploaded Artist cover remains private until the ready owner is inserted with its reference', async () => {
    const artistObjectId = new ObjectId();
    const artistId = artistObjectId.toHexString();
    const imageObjectId = new ObjectId();
    const imageId = imageObjectId.toHexString();
    await getDb()!.collection('imageAssets').insertOne({
        _id: imageObjectId,
        ownerType: 'artist',
        ownerId: artistId,
        createdBy: creatorUserId,
        s3Key: `images/${imageId}`,
        uploadStatus: 'ready',
        uploadUpdatedAt: new Date(),
        uploadError: null
    });

    assert.equal(await getPublicArtist(artistId), null);

    const artist = new Artist(
        'Atomic Artist',
        new SimpleDate(2000, 1, 2),
        'Biography',
        `/content/images/${imageId}`,
        [] as unknown as [string],
        creatorUserId,
        artistObjectId
    );
    artist.coverArtId = imageId;
    await artist.save();

    const published = await getPublicArtist(artistId);
    assert.equal(published?._id, artistId);
    assert.equal(published?.coverArtUrl, `/content/images/${imageId}`);
});

test('uploaded Album cover remains private until the ready owner is inserted with its reference', async () => {
    const albumObjectId = new ObjectId();
    const albumId = albumObjectId.toHexString();
    const imageObjectId = new ObjectId();
    const imageId = imageObjectId.toHexString();
    await getDb()!.collection('imageAssets').insertOne({
        _id: imageObjectId,
        ownerType: 'album',
        ownerId: albumId,
        createdBy: creatorUserId,
        s3Key: `images/${imageId}`,
        uploadStatus: 'ready',
        uploadUpdatedAt: new Date(),
        uploadError: null
    });

    assert.equal(await getPublicAlbum(albumId), null);

    const album = new Album(
        'Atomic Album',
        `/content/images/${imageId}`,
        [] as unknown as [string],
        new SimpleDate(2026, 8, 5),
        creatorUserId,
        albumObjectId
    );
    album.coverArtId = imageId;
    await album.save();

    const published = await getPublicAlbum(albumId);
    assert.equal(published?._id, albumId);
    assert.equal(published?.coverArtUrl, `/content/images/${imageId}`);
});

test('Organization-only Album creation fences and publishes its initial Credit in one transaction', async () => {
    const organizationId = new ObjectId();
    await getDb()!.collection('organizations').insertOne({
        _id: organizationId,
        name: 'Archive House',
        organizationType: 'archive',
        lifecycleStatus: 'ready',
        lifecycleUpdatedAt: new Date(),
        lifecycleError: null,
        referenceRevision: 0,
        createdBy: creatorUserId
    });
    const albumId = new ObjectId();
    const album = new Album(
        'Institutional Release',
        '',
        [] as unknown as [string],
        new SimpleDate(2026, 8, 9),
        creatorUserId,
        albumId
    );
    album.credits = [{
        creditId: 'organization_release',
        subjectType: 'organization',
        subjectId: organizationId.toHexString(),
        role: 'publisher',
        order: 0
    }];
    album.attributionStatus = 'documented';
    album.creditRevision = 1;

    await album.save();

    const stored = await getDb()!.collection('albums').findOne({ _id: albumId });
    assert.equal(stored?.credits?.[0]?.subjectId, organizationId.toHexString());
    assert.equal(
        (await getDb()!.collection('organizations').findOne({ _id: organizationId }))
            ?.referenceRevision,
        1
    );
    assert.equal((await getPublicAlbum(albumId.toHexString()))?.displayByline, 'Archive House');
});

test('Organization-only Soundtrack creation needs no synthetic Artist', async () => {
    const organizationId = new ObjectId();
    await getDb()!.collection('organizations').insertOne({
        _id: organizationId,
        name: 'Broadcast Archive',
        organizationType: 'broadcaster',
        lifecycleStatus: 'ready',
        lifecycleUpdatedAt: new Date(),
        lifecycleError: null,
        referenceRevision: 0,
        createdBy: creatorUserId
    });
    const trackId = new ObjectId();
    const track = new AudioTrack(
        'Institutional Recording',
        [] as unknown as [string],
        [] as unknown as [string],
        '',
        new SimpleDate(2026, 8, 9),
        '',
        new AudioFormat('MP3'),
        '',
        creatorUserId,
        'institutional-recording.mp3',
        'audio/mpeg',
        trackId
    );
    track.credits = [{
        creditId: 'organization_recording',
        subjectType: 'organization',
        subjectId: organizationId.toHexString(),
        role: 'presenter',
        order: 0
    }];
    track.attributionStatus = 'documented';
    track.creditRevision = 1;

    await track.save();

    const stored = await getDb()!.collection('audioTracks').findOne({ _id: trackId });
    assert.deepEqual(stored?.artistIds, []);
    assert.equal(stored?.credits?.[0]?.subjectId, organizationId.toHexString());
    assert.equal(
        (await getDb()!.collection('organizations').findOne({ _id: organizationId }))
            ?.referenceRevision,
        1
    );
});

test('no-cover creates publish ready in one insert while pending owner states remain private', async () => {
    const readyAlbumId = new ObjectId();
    const readyAlbum = new Album(
        'No Cover Album',
        '',
        [] as unknown as [string],
        new SimpleDate(2026, 8, 5),
        creatorUserId,
        readyAlbumId
    );
    await readyAlbum.save();

    const pendingArtistId = new ObjectId();
    const pendingAlbumId = new ObjectId();
    await Promise.all([
        getDb()!.collection('artists').insertOne({
            _id: pendingArtistId,
            name: 'Pending Artist',
            albumIds: [],
            lifecycleStatus: 'pending',
            createdBy: creatorUserId
        }),
        getDb()!.collection('albums').insertOne({
            _id: pendingAlbumId,
            title: 'Pending Album',
            audioTrackIds: [],
            lifecycleStatus: 'pending',
            createdBy: creatorUserId
        })
    ]);

    assert.equal((await getPublicAlbum(readyAlbumId.toHexString()))?._id, readyAlbumId.toHexString());
    assert.equal(await getPublicArtist(pendingArtistId.toHexString()), null);
    assert.equal(await getPublicAlbum(pendingAlbumId.toHexString()), null);
    assert.equal(
        (await listPublicArtists(50, 0)).some((artist) => artist._id === pendingArtistId.toHexString()),
        false
    );
    assert.equal(
        (await listPublicAlbums(50, 0)).some((album) => album._id === pendingAlbumId.toHexString()),
        false
    );
});
