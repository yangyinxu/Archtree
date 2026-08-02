import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { ObjectId } from 'mongodb';

import { getDb } from '../src/infrastructure/database';
import { UserLibrary } from '../src/models/userLibrary';
import {
    MongoReplicaSetHarness,
    startMongoReplicaSet
} from './support/mongoReplicaSet';

let harness: MongoReplicaSetHarness | undefined;

before(async () => {
    harness = await startMongoReplicaSet('archtree-user-library-test');
});

after(async () => {
    await harness?.stop();
});

test('complete Library resolves mixed content with stable cursor pagination', async () => {
    const userId = new ObjectId().toString();
    const albumId = new ObjectId();
    const trackId = new ObjectId();
    const artistId = new ObjectId();
    await Promise.all([
        getDb()!.collection('albums').insertOne({
            _id: albumId,
            title: 'Album',
            coverArtUrl: '',
            audioTrackIds: [trackId.toString()]
        }),
        getDb()!.collection('audioTracks').insertOne({
            _id: trackId,
            title: 'Soundtrack',
            coverArtUrl: '',
            albumId: albumId.toString(),
            artistIds: [artistId.toString()]
        }),
        getDb()!.collection('artists').insertOne({
            _id: artistId,
            name: 'Artist',
            albumIds: [albumId.toString()]
        }),
        getDb()!.collection('userSaves').insertMany([
            {
                userId,
                contentType: 'album',
                contentId: albumId.toString(),
                savedAt: new Date('2026-08-01T10:00:00Z'),
                lastActivityAt: new Date('2026-08-01T10:00:00Z')
            },
            {
                userId,
                contentType: 'audioTrack',
                contentId: trackId.toString(),
                savedAt: new Date('2026-08-02T10:00:00Z'),
                lastActivityAt: new Date('2026-08-02T10:00:00Z')
            }
        ])
    ]);

    const first = await UserLibrary.list(userId, {
        sort: 'recentActivity',
        limit: 1
    });
    const second = await UserLibrary.list(userId, {
        sort: 'recentActivity',
        limit: 1,
        cursor: first.nextCursor ?? undefined
    });

    assert.equal(first.items.length, 1);
    assert.equal(first.items[0].contentType, 'audioTrack');
    assert.equal(first.items[0].audioTrack.title, 'Soundtrack');
    assert.equal(first.items[0].creator, 'Artist');
    assert.ok(first.nextCursor);
    assert.equal(second.items.length, 1);
    assert.equal(second.items[0].contentType, 'album');
    assert.equal(second.items[0].album.title, 'Album');
    assert.equal(second.items[0].creator, 'Artist');
    assert.equal(second.nextCursor, null);
});

test('recently played sort places played saves before unplayed saves', async () => {
    const userId = new ObjectId().toString();
    const playedAlbumId = new ObjectId();
    const unplayedAlbumId = new ObjectId();
    await getDb()!.collection('albums').insertMany([
        { _id: playedAlbumId, title: 'Played', coverArtUrl: '', audioTrackIds: [] },
        { _id: unplayedAlbumId, title: 'Unplayed', coverArtUrl: '', audioTrackIds: [] }
    ]);
    await getDb()!.collection('userSaves').insertMany([
        {
            userId,
            contentType: 'album',
            contentId: playedAlbumId.toString(),
            savedAt: new Date('2026-08-01T10:00:00Z'),
            lastPlayedAt: new Date('2026-08-01T11:00:00Z')
        },
        {
            userId,
            contentType: 'album',
            contentId: unplayedAlbumId.toString(),
            savedAt: new Date('2026-08-02T10:00:00Z')
        }
    ]);

    const page = await UserLibrary.list(userId, { sort: 'recentlyPlayed' });

    assert.deepEqual(
        page.items.map((item: any) => item.contentId),
        [playedAlbumId.toString(), unplayedAlbumId.toString()]
    );
});

test('recently played pagination continues from played into unplayed saves', async () => {
    const userId = new ObjectId().toString();
    const playedAlbumId = new ObjectId();
    const unplayedAlbumId = new ObjectId();
    await getDb()!.collection('albums').insertMany([
        { _id: playedAlbumId, title: 'Played', coverArtUrl: '', audioTrackIds: [] },
        { _id: unplayedAlbumId, title: 'Unplayed', coverArtUrl: '', audioTrackIds: [] }
    ]);
    await getDb()!.collection('userSaves').insertMany([
        {
            userId,
            contentType: 'album',
            contentId: playedAlbumId.toString(),
            savedAt: new Date('2026-08-01T10:00:00Z'),
            lastPlayedAt: new Date('2026-08-01T11:00:00Z')
        },
        {
            userId,
            contentType: 'album',
            contentId: unplayedAlbumId.toString(),
            savedAt: new Date('2026-08-02T10:00:00Z')
        }
    ]);

    const first = await UserLibrary.list(userId, {
        sort: 'recentlyPlayed',
        limit: 1
    });
    const second = await UserLibrary.list(userId, {
        sort: 'recentlyPlayed',
        limit: 1,
        cursor: first.nextCursor ?? undefined
    });

    assert.equal(first.items[0].contentId, playedAlbumId.toString());
    assert.ok(first.nextCursor);
    assert.equal(second.items[0].contentId, unplayedAlbumId.toString());
    assert.equal(second.nextCursor, null);
});

test('recording playback updates durable saved activity and bounded history together', async () => {
    const userId = new ObjectId().toString();
    const albumId = new ObjectId();
    await getDb()!.collection('albums').insertOne({
        _id: albumId,
        title: 'Album',
        coverArtUrl: '',
        audioTrackIds: []
    });
    await getDb()!.collection('userSaves').insertOne({
        userId,
        contentType: 'album',
        contentId: albumId.toString(),
        savedAt: new Date('2026-08-01T10:00:00Z')
    });

    await UserLibrary.recordPlayed(userId, 'album', albumId.toString());

    const save = await getDb()!.collection('userSaves').findOne({
        userId,
        contentType: 'album',
        contentId: albumId.toString()
    });
    const activity = await getDb()!.collection('userActivity').findOne({ userId });
    assert.ok(save?.lastPlayedAt instanceof Date);
    assert.ok(save?.lastActivityAt instanceof Date);
    assert.equal(activity?.recentlyPlayed.length, 1);
    assert.equal(activity?.recentlyPlayed[0].contentId, albumId.toString());
});
