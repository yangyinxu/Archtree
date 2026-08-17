import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { ObjectId } from 'mongodb';

import { getDb } from '../src/infrastructure/database';
import {
    addAlbumToArtist,
    removeAlbumFromArtist,
    replaceArtistAlbums
} from '../src/services/artistAlbumLinkService';
import {
    MongoReplicaSetHarness,
    startMongoReplicaSet
} from './support/mongoReplicaSet';

let harness: MongoReplicaSetHarness | undefined;

before(async () => {
    harness = await startMongoReplicaSet('archtree-artist-album-link-test');
});

beforeEach(async () => {
    await Promise.all([
        getDb()!.collection('artists').deleteMany({}),
        getDb()!.collection('albums').deleteMany({})
    ]);
});

after(async () => {
    await harness?.stop();
});

const insertReadyCatalog = async () => {
    const artistId = new ObjectId();
    const firstAlbumId = new ObjectId();
    const secondAlbumId = new ObjectId();
    await Promise.all([
        getDb()!.collection('artists').insertOne({
            _id: artistId,
            name: 'Relationship Artist',
            albumIds: [],
            lifecycleStatus: 'ready',
            referenceRevision: 0
        }),
        getDb()!.collection('albums').insertMany([
            {
                _id: firstAlbumId,
                title: 'First Album',
                lifecycleStatus: 'ready',
                referenceRevision: 0
            },
            {
                _id: secondAlbumId,
                title: 'Second Album',
                lifecycleStatus: 'ready',
                referenceRevision: 0
            }
        ])
    ]);
    return { artistId, firstAlbumId, secondAlbumId };
};

test('Artist Album add/remove is idempotent and never deletes either record', async () => {
    const { artistId, firstAlbumId } = await insertReadyCatalog();
    const artist = artistId.toHexString();
    const album = firstAlbumId.toHexString();

    assert.equal(await addAlbumToArtist(artist, album), 'added');
    assert.equal(await addAlbumToArtist(artist, album), 'alreadyLinked');
    assert.deepEqual(
        (await getDb()!.collection('artists').findOne({ _id: artistId }))!.albumIds,
        [album]
    );

    assert.equal(await removeAlbumFromArtist(artist, album), 'removed');
    assert.equal(await removeAlbumFromArtist(artist, album), 'notLinked');
    assert.deepEqual(
        (await getDb()!.collection('artists').findOne({ _id: artistId }))!.albumIds,
        []
    );
    assert.ok(await getDb()!.collection('artists').findOne({ _id: artistId }));
    assert.ok(await getDb()!.collection('albums').findOne({ _id: firstAlbumId }));
});

test('complete membership replacement accepts empty and preserves requested order', async () => {
    const { artistId, firstAlbumId, secondAlbumId } = await insertReadyCatalog();
    const requested = [secondAlbumId.toHexString(), firstAlbumId.toHexString()];

    assert.deepEqual(await replaceArtistAlbums(artistId.toHexString(), requested), requested);
    assert.deepEqual(
        (await getDb()!.collection('artists').findOne({ _id: artistId }))!.albumIds,
        requested
    );

    assert.deepEqual(await replaceArtistAlbums(artistId.toHexString(), []), []);
    assert.deepEqual(
        (await getDb()!.collection('artists').findOne({ _id: artistId }))!.albumIds,
        []
    );
});

test('a deleting reference aborts without changing membership', async () => {
    const { artistId, firstAlbumId } = await insertReadyCatalog();
    await getDb()!.collection('albums').updateOne(
        { _id: firstAlbumId },
        { $set: { lifecycleStatus: 'deleting' } }
    );

    await assert.rejects(
        addAlbumToArtist(artistId.toHexString(), firstAlbumId.toHexString()),
        (error: any) => error?.code === 'album_reference_unavailable'
    );
    assert.deepEqual(
        (await getDb()!.collection('artists').findOne({ _id: artistId }))!.albumIds,
        []
    );
});
