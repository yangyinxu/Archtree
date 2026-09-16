import assert from 'node:assert/strict';
import { after, before, test, type TestContext } from 'node:test';
import { Collection, ObjectId } from 'mongodb';

import { getDb } from '../src/infrastructure/database';
import { UserLibrary } from '../src/models/userLibrary';
import { deleteListenerAccountData } from '../src/services/accountDeletionService';
import { AccountReferenceUnavailableError } from '../src/services/accountReferenceFenceService';
import {
    MongoReplicaSetHarness,
    startMongoReplicaSet
} from './support/mongoReplicaSet';

let harness: MongoReplicaSetHarness | undefined;

test('saved search covers the full collection before pagination and escapes regex syntax', async () => {
    const userId = new ObjectId().toString();
    const otherUser = new ObjectId().toString();
    const albums = Array.from({ length: 35 }, (_, index) => ({
        _id: new ObjectId(), title: index < 2 ? 'Old [record]' : `Recent ${index}`, coverArtUrl: '', audioTrackIds: []
    }));
    await getDb()!.collection('albums').insertMany(albums);
    await getDb()!.collection('userSaves').insertMany(albums.map((album, index) => ({
        userId, contentType: 'album', contentId: album._id.toString(),
        savedAt: new Date(2026, 0, index + 1), lastActivityAt: new Date(2026, 0, index + 1)
    })));
    const all = await UserLibrary.list(userId, { limit: 100 });
    assert.equal(all.items.length, 35);
    const first = await UserLibrary.list(userId, { query: '[record]', limit: 1 });
    assert.equal(first.items.length, 1);
    assert.ok(first.nextCursor);
    const second = await UserLibrary.list(userId, { query: '[record]', limit: 1, cursor: first.nextCursor });
    assert.equal(second.items.length, 1);
    assert.notEqual(first.items[0].contentId, second.items[0].contentId);
    assert.equal(second.nextCursor, null);
    assert.equal((await UserLibrary.list(userId, { query: '[record]', contentTypes: ['audioTrack'] })).items.length, 0);
    assert.equal((await UserLibrary.list(otherUser, { query: '[record]' })).items.length, 0);
});

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
            artistIds: [artistId.toString()],
            uploadStatus: 'ready',
            s3Key: trackId.toHexString()
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
    await Promise.all([
        getDb()!.collection('albums').insertOne({
            _id: albumId,
            title: 'Album',
            coverArtUrl: '',
            audioTrackIds: []
        }),
        getDb()!.collection('users').insertOne({ _id: ObjectId.createFromHexString(userId) })
    ]);
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

/** Coordinates actual transaction boundaries without production-only test hooks. */
const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
};

/** Creates one independent owner and a valid saved Album through the public model operation. */
const seedSavedAlbum = async () => {
    const userId = new ObjectId().toHexString();
    const albumId = new ObjectId().toHexString();
    await getDb()!.collection('users').insertOne({ _id: new ObjectId(userId), email: `${userId}@example.com` });
    await getDb()!.collection('albums').insertOne({ _id: new ObjectId(albumId), title: 'Synthetic Album' });
    await UserLibrary.save(userId, 'album', albumId);
    return { userId, albumId };
};

/** Holds the unsave transaction after the first write, when a partial commit would be harmful. */
const pauseUnsave = (context: TestContext, userId: string) => {
    const removed = deferred();
    const release = deferred();
    const original = Collection.prototype.deleteOne;
    context.mock.method(Collection.prototype, 'deleteOne', async function (this: Collection, ...args: any[]) {
        const result = await (original as any).apply(this, args);
        if (this.collectionName === 'userSaves' && args[0]?.userId === userId) {
            removed.resolve();
            await release.promise;
        }
        return result;
    });
    return { removed: removed.promise, release: release.resolve };
};

/** Signals that a competing operation has reached the same durable account fence. */
const observeAccountFence = (context: TestContext, userId: string) => {
    const attempted = deferred();
    const original = Collection.prototype.updateOne;
    context.mock.method(Collection.prototype, 'updateOne', function (this: Collection, ...args: any[]) {
        if (this.collectionName === 'users' && String(args[0]?._id) === userId
            && args[1]?.$inc?.listenerMutationRevision === 1) attempted.resolve();
        return (original as any).apply(this, args);
    });
    return attempted.promise;
};

test('unsave rolls back the save removal when its activity write fails', async (context) => {
    const { userId, albumId } = await seedSavedAlbum();
    const original = Collection.prototype.updateOne;
    context.mock.method(Collection.prototype, 'updateOne', function (this: Collection, ...args: any[]) {
        if (this.collectionName === 'userActivity' && args[0]?.userId === userId) {
            return Promise.reject(new Error('Synthetic activity write failure'));
        }
        return (original as any).apply(this, args);
    });
    await assert.rejects(UserLibrary.unsave(userId, 'album', albumId), /Synthetic activity write failure/);
    assert.equal((await UserLibrary.statuses(userId, [{ contentType: 'album', contentId: albumId }]))[0].saved, true);
    assert.equal((await UserLibrary.recent(userId, 'recentlySaved'))[0].contentId, albumId);
});

test('unsave is owner-scoped and idempotently removes its Recently Saved entry', async () => {
    const { userId, albumId } = await seedSavedAlbum();
    const otherUserId = new ObjectId().toHexString();
    await getDb()!.collection('users').insertOne({ _id: new ObjectId(otherUserId), email: `${otherUserId}@example.com` });
    await UserLibrary.save(otherUserId, 'album', albumId);
    await UserLibrary.unsave(userId, 'album', albumId);
    await UserLibrary.unsave(userId, 'album', albumId);
    assert.equal((await UserLibrary.statuses(userId, [{ contentType: 'album', contentId: albumId }]))[0].saved, false);
    assert.deepEqual(await UserLibrary.recent(userId, 'recentlySaved'), []);
    assert.equal((await UserLibrary.statuses(otherUserId, [{ contentType: 'album', contentId: albumId }]))[0].saved, true);
    assert.equal((await UserLibrary.recent(otherUserId, 'recentlySaved'))[0].contentId, albumId);
});

test('a save racing unsave restores both the save and Recently Saved after the unsave commits', async (context) => {
    const { userId, albumId } = await seedSavedAlbum();
    const pause = pauseUnsave(context, userId);
    const unsave = UserLibrary.unsave(userId, 'album', albumId);
    await pause.removed;
    const fenceAttempted = observeAccountFence(context, userId);
    const save = UserLibrary.save(userId, 'album', albumId);
    try { await fenceAttempted; } finally { pause.release(); }
    await Promise.all([unsave, save]);
    assert.equal((await UserLibrary.statuses(userId, [{ contentType: 'album', contentId: albumId }]))[0].saved, true);
    assert.equal((await UserLibrary.recent(userId, 'recentlySaved'))[0].contentId, albumId);
});

test('an unsave racing an admitted save removes both its save and Recently Saved entry', async (context) => {
    const { userId, albumId } = await seedSavedAlbum();
    const saved = deferred();
    const release = deferred();
    const original = Collection.prototype.updateOne;
    context.mock.method(Collection.prototype, 'updateOne', async function (this: Collection, ...args: any[]) {
        const result = await (original as any).apply(this, args);
        if (this.collectionName === 'userSaves' && args[0]?.userId === userId) {
            saved.resolve();
            await release.promise;
        }
        return result;
    });
    const save = UserLibrary.save(userId, 'album', albumId);
    await saved.promise;
    const fenceAttempted = observeAccountFence(context, userId);
    const unsave = UserLibrary.unsave(userId, 'album', albumId);
    try { await fenceAttempted; } finally { release.resolve(); }
    await Promise.all([save, unsave]);
    assert.equal((await UserLibrary.statuses(userId, [{ contentType: 'album', contentId: albumId }]))[0].saved, false);
    assert.deepEqual(await UserLibrary.recent(userId, 'recentlySaved'), []);
});

test('account deletion after an admitted unsave removes all private data', async (context) => {
    const { userId, albumId } = await seedSavedAlbum();
    const pause = pauseUnsave(context, userId);
    const unsave = UserLibrary.unsave(userId, 'album', albumId);
    await pause.removed;
    const deletionStarted = deferred();
    const deletion = deleteListenerAccountData(userId, {
        beforeAccountFence: async () => { deletionStarted.resolve(); }
    });
    try { await deletionStarted.promise; } finally { pause.release(); }
    await unsave;
    assert.deepEqual(await deletion, { status: 'deleted' });
    assert.equal(await getDb()!.collection('userSaves').countDocuments({ userId }), 0);
    assert.equal(await getDb()!.collection('userActivity').countDocuments({ userId }), 0);
});

test('an unsave racing committed account deletion rejects without recreating private state', async (context) => {
    const { userId, albumId } = await seedSavedAlbum();
    const fenced = deferred();
    const release = deferred();
    const deletion = deleteListenerAccountData(userId, {
        afterAccountFence: async () => { fenced.resolve(); await release.promise; }
    });
    await fenced.promise;
    const fenceAttempted = observeAccountFence(context, userId);
    const unsave = assert.rejects(UserLibrary.unsave(userId, 'album', albumId), AccountReferenceUnavailableError);
    try { await fenceAttempted; } finally { release.resolve(); }
    assert.deepEqual(await deletion, { status: 'deleted' });
    await unsave;
    assert.equal(await getDb()!.collection('userSaves').countDocuments({ userId }), 0);
    assert.equal(await getDb()!.collection('userActivity').countDocuments({ userId }), 0);
});
