import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, test } from 'node:test';
import { ObjectId } from 'mongodb';

import { createApp } from '../../src/app';
import { getDb } from '../../src/infrastructure/database';
import { createPersonalAttribution } from '../../src/models/personalAttribution';
import { startMongoReplicaSet, type MongoReplicaSetHarness } from '../support/mongoReplicaSet';

let harness: MongoReplicaSetHarness, server: Server, base = '';
const owner = new ObjectId(), album = new ObjectId(), artist = new ObjectId();
const named = new ObjectId(), unnamed = new ObjectId(), image = new ObjectId();
const previousReads = process.env.CATALOG_CREDIT_READS_ENABLED;
const track = (_id: ObjectId, publicName: string, albumId: string | null) => ({
    _id, title: `Lorem Video ${publicName || 'Neutral'}`, albumId, artistIds: [],
    credits: [], attributionStatus: 'unknown', personalAttribution: createPersonalAttribution(owner.toHexString(), publicName),
    mediaType: 'video', uploadStatus: 'ready', publicationStatus: 'ready', contentType: 'video/mp4',
    s3Key: `video/${_id}/${new ObjectId()}`, createdBy: owner.toHexString(), duration: '00:12'
});
const read = async (path: string) => {
    const response = await fetch(base + path);
    assert.equal(response.status, 200, path);
    const body: any = await response.json();
    const wire = JSON.stringify(body);
    for (const secret of ['personalAttribution', 'ownerId', owner.toHexString(), 'private@example.test', 'Private Account', 'private-avatar', 's3Key']) {
        assert.equal(wire.includes(secret), false, secret);
    }
    return body;
};

before(async () => {
    process.env.CATALOG_CREDIT_READS_ENABLED = 'true';
    harness = await startMongoReplicaSet('archtree-personal-attribution-test');
    const db = getDb()!;
    await db.collection('users').insertOne({ _id: owner, email: 'private@example.test', displayName: 'Private Account', avatarUrl: '/private-avatar.jpg' });
    await db.collection('artists').insertOne({ _id: artist, name: 'Lorem Ensemble', lifecycleStatus: 'ready', albumIds: [album.toHexString()] });
    await db.collection('albums').insertOne({
        _id: album, title: 'Lorem Album', lifecycleStatus: 'ready', audioTrackIds: [unnamed.toHexString()], coverArtUrl: '/lorem-album.jpg',
        credits: [{ creditId: 'lorem_album_credit', subjectType: 'artist', subjectId: artist.toHexString(), role: 'primary', order: 0 }], attributionStatus: 'documented'
    });
    await db.collection('audioTracks').insertMany([
        { ...track(named, 'Lorem Film', null), coverArtId: image.toHexString(), artistIds: [artist.toHexString()] },
        track(unnamed, '', album.toHexString())
    ]);
    server = await new Promise(resolve => { const active = createApp().listen(0, '127.0.0.1', () => resolve(active)); });
    const address = server.address(); assert.ok(address && typeof address !== 'string'); base = `http://127.0.0.1:${address.port}`;
});
after(async () => {
    await new Promise<void>(resolve => server?.close(() => resolve()));
    await harness?.stop();
    if (previousReads === undefined) delete process.env.CATALOG_CREDIT_READS_ENABLED; else process.env.CATALOG_CREDIT_READS_ENABLED = previousReads;
});

test('public Videos show explicit personal signatures without account identities or synthetic Artist Credits', async () => {
    const body = await read('/api/listener/v1/videos');
    assert.equal(body.items.length, 2);
    for (const [id, expected] of [[named, 'Lorem Film'], [unnamed, '个人发布']] as const) {
        const item = body.items.find((value: any) => value.id === id.toHexString());
        assert.ok(item);
        assert.equal(item.displayByline, expected);
        assert.deepEqual(item.credits, []);
        assert.deepEqual(item.artistNames, []);
        assert.equal(item.attributionStatus, 'unknown');
        assert.equal(item.mediaType, 'video');
        assert.equal(item.streamUrl, `/content/mediaTrack/stream/${id}`);
    }
    assert.equal(body.items.find((value: any) => value.id === named.toHexString()).artworkUrl, `/content/images/${image}`);
});

test('a linked personal Video keeps its own byline and inherits only Album artwork', async () => {
    const body = await read(`/api/listener/v1/albums/${album}`);
    assert.equal(body.album.displayByline, 'Lorem Ensemble');
    assert.equal(body.tracks.length, 1);
    assert.equal(body.tracks[0].displayByline, '个人发布');
    assert.deepEqual(body.tracks[0].credits, []);
    assert.deepEqual(body.tracks[0].artistNames, []);
    assert.equal(body.tracks[0].artworkUrl, '/lorem-album.jpg');
    const legacy = await read('/content/audioTracks');
    for (const item of legacy.audioTracks) assert.deepEqual(item.artistIds, []);
    assert.equal(legacy.audioTracks.find((value: any) => value._id === named.toHexString()).displayByline, 'Lorem Film');
    assert.equal(legacy.audioTracks.find((value: any) => value._id === unnamed.toHexString()).displayByline, '个人发布');
});

test('personal signatures do not bypass parent visibility or publication readiness', async () => {
    await getDb()!.collection('albums').updateOne({ _id: album }, { $set: { visibility: 'hidden' } });
    await getDb()!.collection('audioTracks').updateOne({ _id: named }, { $set: { publicationStatus: 'pending' } });
    const body = await read('/api/listener/v1/videos');
    assert.deepEqual(body.items, []);
});
