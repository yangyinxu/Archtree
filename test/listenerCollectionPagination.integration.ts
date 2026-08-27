import assert from 'node:assert/strict';
import { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import jwt from 'jsonwebtoken';
import { ObjectId } from 'mongodb';

import { createApp } from '../src/app';
import { getDb } from '../src/infrastructure/database';
import {
    MongoReplicaSetHarness,
    startMongoReplicaSet
} from './support/mongoReplicaSet';

let harness: MongoReplicaSetHarness | undefined;
let server: Server | undefined;
let baseUrl = '';

const ids = {
    userOne: new ObjectId(),
    userTwo: new ObjectId(),
    sessionOne: new ObjectId(),
    sessionTwo: new ObjectId(),
    artist: new ObjectId(),
    albumOne: new ObjectId(),
    albumTwo: new ObjectId(),
    albumDeleting: new ObjectId(),
    trackOne: new ObjectId(),
    trackTwo: new ObjectId(),
    trackThree: new ObjectId(),
    trackPending: new ObjectId(),
    gridCollection: new ObjectId(),
    listCollection: new ObjectId(),
    libraryCollection: new ObjectId(),
    dynamicCollection: new ObjectId(),
    gridItem: new ObjectId(),
    listItem: new ObjectId(),
    libraryItem: new ObjectId(),
    dynamicItem: new ObjectId()
};

const closeServer = (target?: Server) => new Promise<void>((resolve, reject) => {
    if (!target) return resolve();
    target.close((error) => error ? reject(error) : resolve());
});

const allObjectKeys = (value: unknown, keys = new Set<string>()) => {
    if (!value || typeof value !== 'object') return keys;
    if (Array.isArray(value)) {
        for (const item of value) allObjectKeys(item, keys);
        return keys;
    }
    for (const [key, nested] of Object.entries(value)) {
        keys.add(key);
        allObjectKeys(nested, keys);
    }
    return keys;
};

const expectSafe = (payload: unknown) => {
    const keys = allObjectKeys(payload);
    for (const forbidden of [
        'createdBy', 'updatedBy', 'coverArtId', 's3Key', 'uploadStatus',
        'publicationStatus', 'uploadError', 'lifecycleStatus', 'lifecycleError'
    ]) {
        assert.equal(keys.has(forbidden), false, `response exposed ${forbidden}`);
    }
};

const accessToken = (userId: ObjectId, sessionId: ObjectId, email: string) => jwt.sign({
    userId: userId.toHexString(),
    email,
    role: 'user',
    sessionId: sessionId.toHexString(),
    tokenType: 'access'
}, process.env.JWT_SECRET!, { expiresIn: 60 });

const request = (
    pathname: string,
    token?: string
) => fetch(`${baseUrl}${pathname}`, token ? {
    headers: { Authorization: `Bearer ${token}` }
} : undefined);

before(async () => {
    harness = await startMongoReplicaSet('archtree-listener-collection-pagination-test');
    const db = getDb()!;
    const artistId = ids.artist.toHexString();
    const trackDocuments = [
        [ids.trackOne, 'Track One', '03:01', 'ready'],
        [ids.trackTwo, 'Track Two', '03:02', 'ready'],
        [ids.trackThree, 'Track Three', '03:03', 'ready'],
        [ids.trackPending, 'Track Pending', '03:04', 'pending']
    ].map(([id, title, duration, uploadStatus]) => ({
        _id: id,
        title,
        duration,
        artistIds: [artistId],
        coverArtUrl: '/track.jpg',
        uploadStatus,
        s3Key: (id as ObjectId).toHexString(),
        createdBy: 'private-owner',
        uploadError: uploadStatus === 'ready' ? null : 'private failure'
    }));
    await Promise.all([
        db.collection('users').insertMany([
            {
                _id: ids.userOne,
                email: 'listener-one@example.test',
                username: 'listener-one',
                password: 'unused',
                posts: [],
                role: 'user'
            },
            {
                _id: ids.userTwo,
                email: 'listener-two@example.test',
                username: 'listener-two',
                password: 'unused',
                posts: [],
                role: 'user'
            }
        ]),
        db.collection('authSessions').insertMany([
            {
                _id: ids.sessionOne,
                userId: ids.userOne.toHexString(),
                refreshTokenHash: 'listener-one-hash',
                createdAt: new Date(),
                updatedAt: new Date(),
                expiresAt: new Date(Date.now() + 60_000)
            },
            {
                _id: ids.sessionTwo,
                userId: ids.userTwo.toHexString(),
                refreshTokenHash: 'listener-two-hash',
                createdAt: new Date(),
                updatedAt: new Date(),
                expiresAt: new Date(Date.now() + 60_000)
            }
        ]),
        db.collection('artists').insertOne({
            _id: ids.artist,
            name: 'Cursor Artist',
            albumIds: [ids.albumOne.toHexString(), ids.albumTwo.toHexString()],
            createdBy: 'private-owner'
        }),
        db.collection('albums').insertMany([
            {
                _id: ids.albumOne,
                title: 'Album One',
                coverArtUrl: '/album-one.jpg',
                audioTrackIds: [],
                createdBy: 'private-owner'
            },
            {
                _id: ids.albumTwo,
                title: 'Album Two',
                coverArtUrl: '/album-two.jpg',
                audioTrackIds: [],
                createdBy: 'private-owner'
            },
            {
                _id: ids.albumDeleting,
                title: 'Deleting Album',
                lifecycleStatus: 'deleting',
                lifecycleError: 'private lifecycle detail',
                createdBy: 'private-owner'
            }
        ]),
        db.collection('audioTracks').insertMany(trackDocuments),
        db.collection('contentCollections').insertMany([
            {
                _id: ids.gridCollection,
                name: 'Paged Albums',
                presentation: 'grid',
                mode: 'manual',
                contentType: 'album',
                items: [
                    { contentType: 'album', contentId: ids.albumTwo.toHexString(), order: 0 },
                    { contentType: 'album', contentId: ids.albumDeleting.toHexString(), order: 1 },
                    { contentType: 'album', contentId: ids.albumOne.toHexString(), order: 2 }
                ],
                createdBy: 'private-owner'
            },
            {
                _id: ids.listCollection,
                name: 'Paged Songs',
                presentation: 'list',
                mode: 'manual',
                contentType: 'audioTrack',
                items: [
                    { contentType: 'audioTrack', contentId: ids.trackOne.toHexString(), order: 0 },
                    { contentType: 'audioTrack', contentId: ids.trackTwo.toHexString(), order: 1 },
                    { contentType: 'audioTrack', contentId: ids.trackPending.toHexString(), order: 2 },
                    { contentType: 'audioTrack', contentId: ids.trackThree.toHexString(), order: 3 }
                ],
                createdBy: 'private-owner'
            },
            {
                _id: ids.libraryCollection,
                name: 'Private Parent Songs',
                presentation: 'list',
                mode: 'manual',
                contentType: 'audioTrack',
                items: [
                    { contentType: 'audioTrack', contentId: ids.trackOne.toHexString(), order: 0 },
                    { contentType: 'audioTrack', contentId: ids.trackTwo.toHexString(), order: 1 },
                    { contentType: 'audioTrack', contentId: ids.trackThree.toHexString(), order: 2 }
                ]
            },
            {
                _id: ids.dynamicCollection,
                name: 'Downloaded Songs',
                presentation: 'list',
                mode: 'dynamic',
                contentType: 'audioTrack',
                dynamicSource: 'downloadedSongs',
                items: []
            }
        ]),
        db.collection('pages').insertMany([
            {
                slug: 'home',
                title: 'Home',
                items: [
                    {
                        itemId: ids.gridItem.toHexString(),
                        itemType: 'grid',
                        collectionId: ids.gridCollection.toHexString(),
                        order: 0
                    },
                    {
                        itemId: ids.listItem.toHexString(),
                        itemType: 'list',
                        collectionId: ids.listCollection.toHexString(),
                        order: 1
                    },
                    {
                        itemId: ids.dynamicItem.toHexString(),
                        itemType: 'list',
                        collectionId: ids.dynamicCollection.toHexString(),
                        order: 2
                    }
                ]
            },
            {
                slug: 'library',
                title: 'Library',
                items: [{
                    itemId: ids.libraryItem.toHexString(),
                    itemType: 'list',
                    collectionId: ids.libraryCollection.toHexString(),
                    order: 0
                }]
            }
        ])
    ]);

    const app = createApp({
        listenerDistPath: path.join(os.tmpdir(), 'archtree-listener-pagination-missing')
    });
    server = await new Promise<Server>((resolve) => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
    await closeServer(server);
    await harness?.stop();
});

test('Listener Grid/List cursor pages are bounded, lifecycle-safe, and strictly scoped', async () => {
    const homeResponse = await request('/api/listener/v1/home');
    const home: any = await homeResponse.json();
    assert.equal(homeResponse.status, 200);
    assert.deepEqual(home.sections.map((section: any) => section.id), [
        ids.gridItem.toHexString(),
        ids.listItem.toHexString(),
        ids.dynamicItem.toHexString()
    ]);

    const firstGridResponse = await request(
        `/api/listener/v1/pages/home/items/${ids.gridItem}?limit=1`
    );
    const firstGrid: any = await firstGridResponse.json();
    assert.equal(firstGridResponse.status, 200);
    assert.equal(firstGrid.limit, 1);
    assert.equal(firstGrid.pageItem.id, ids.gridItem.toHexString());
    assert.deepEqual(firstGrid.items, [{
        contentType: 'album',
        contentId: ids.albumTwo.toHexString(),
        order: 0
    }]);
    assert.deepEqual(firstGrid.included.albums.map((album: any) => album.id), [
        ids.albumTwo.toHexString()
    ]);
    assert.equal(firstGrid.included.albums[0].artistNames[0], 'Cursor Artist');
    assert.ok(firstGrid.nextCursor);
    expectSafe(firstGrid);

    const secondGridResponse = await request(
        `/api/listener/v1/pages/home/items/${ids.gridItem}?limit=1&cursor=${encodeURIComponent(firstGrid.nextCursor)}`
    );
    const secondGrid: any = await secondGridResponse.json();
    assert.equal(secondGridResponse.status, 200);
    assert.deepEqual(secondGrid.items.map((item: any) => item.contentId), [
        ids.albumOne.toHexString()
    ]);
    assert.equal(secondGrid.nextCursor, null);
    expectSafe(secondGrid);

    const malformed = await request(
        `/api/listener/v1/pages/home/items/${ids.gridItem}?cursor=not-a-cursor`
    );
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json() as any).code, 'invalid_collection_cursor');

    const [cursorPayload, cursorSignature] = firstGrid.nextCursor.split('.');
    const tamperedCursor = `${cursorPayload}.${
        cursorSignature.startsWith('A') ? 'B' : 'A'
    }${cursorSignature.slice(1)}`;
    const tampered = await request(
        `/api/listener/v1/pages/home/items/${ids.gridItem}?cursor=${encodeURIComponent(tamperedCursor)}`
    );
    assert.equal(tampered.status, 400);
    assert.equal((await tampered.json() as any).code, 'invalid_collection_cursor');

    const crossItem = await request(
        `/api/listener/v1/pages/home/items/${ids.listItem}?cursor=${encodeURIComponent(firstGrid.nextCursor)}`
    );
    assert.equal(crossItem.status, 409);
    assert.equal((await crossItem.json() as any).code, 'collection_cursor_mismatch');

    const bounded = await request(
        `/api/listener/v1/pages/home/items/${ids.listItem}?limit=999`
    );
    const boundedBody: any = await bounded.json();
    assert.equal(bounded.status, 200);
    assert.equal(boundedBody.limit, 100);
    assert.deepEqual(boundedBody.items.map((item: any) => item.contentId), [
        ids.trackOne.toHexString(),
        ids.trackTwo.toHexString(),
        ids.trackThree.toHexString()
    ]);
    assert.equal(boundedBody.included.audioTracks[0].duration, '03:01');
    assert.deepEqual(boundedBody.included.audioTracks[0].artistNames, ['Cursor Artist']);
    expectSafe(boundedBody);

    const invalidLimit = await request(
        `/api/listener/v1/pages/home/items/${ids.listItem}?limit=1.5`
    );
    assert.equal(invalidLimit.status, 400);
    assert.equal((await invalidLimit.json() as any).code, 'invalid_collection_page_limit');

    const unknownQuery = await request(
        `/api/listener/v1/pages/home/items/${ids.listItem}?offset=1`
    );
    assert.equal(unknownQuery.status, 400);
    assert.equal((await unknownQuery.json() as any).code, 'invalid_collection_page_query');

    const dynamic = await request(
        `/api/listener/v1/pages/home/items/${ids.dynamicItem}`
    );
    assert.equal(dynamic.status, 409);
    assert.equal((await dynamic.json() as any).code, 'collection_source_not_server_backed');

    const anonymousLibrary = await request(
        `/api/listener/v1/pages/library/items/${ids.libraryItem}`
    );
    assert.equal(anonymousLibrary.status, 401);

    const tokenOne = accessToken(ids.userOne, ids.sessionOne, 'listener-one@example.test');
    const tokenTwo = accessToken(ids.userTwo, ids.sessionTwo, 'listener-two@example.test');
    const firstLibraryResponse = await request(
        `/api/listener/v1/pages/library/items/${ids.libraryItem}?limit=1`,
        tokenOne
    );
    const firstLibrary: any = await firstLibraryResponse.json();
    assert.equal(firstLibraryResponse.status, 200);
    assert.ok(firstLibrary.nextCursor);
    assert.equal(firstLibraryResponse.headers.get('cache-control'), 'private, no-store');

    const replayedAcrossViewer = await request(
        `/api/listener/v1/pages/library/items/${ids.libraryItem}?limit=1&cursor=${encodeURIComponent(firstLibrary.nextCursor)}`,
        tokenTwo
    );
    assert.equal(replayedAcrossViewer.status, 409);
    assert.equal((await replayedAcrossViewer.json() as any).code, 'collection_cursor_mismatch');

    await getDb()!.collection('audioTracks').deleteOne({ _id: ids.trackTwo });
    const afterDeletionResponse = await request(
        `/api/listener/v1/pages/library/items/${ids.libraryItem}?limit=1&cursor=${encodeURIComponent(firstLibrary.nextCursor)}`,
        tokenOne
    );
    const afterDeletion: any = await afterDeletionResponse.json();
    assert.equal(afterDeletionResponse.status, 200);
    assert.deepEqual(afterDeletion.items.map((item: any) => item.contentId), [
        ids.trackThree.toHexString()
    ]);
    assert.equal(afterDeletion.nextCursor, null);

    const firstListResponse = await request(
        `/api/listener/v1/pages/home/items/${ids.listItem}?limit=1`
    );
    const firstList: any = await firstListResponse.json();
    assert.equal(firstListResponse.status, 200);
    assert.ok(firstList.nextCursor);
    await getDb()!.collection('audioTracks').updateOne(
        { _id: ids.trackOne },
        { $set: { uploadStatus: 'pending' } }
    );
    const afterLifecycleChangeResponse = await request(
        `/api/listener/v1/pages/home/items/${ids.listItem}?limit=1&cursor=${encodeURIComponent(firstList.nextCursor)}`
    );
    const afterLifecycleChange: any = await afterLifecycleChangeResponse.json();
    assert.equal(afterLifecycleChangeResponse.status, 200);
    assert.deepEqual(afterLifecycleChange.items.map((item: any) => item.contentId), [
        ids.trackThree.toHexString()
    ]);
    assert.equal(afterLifecycleChange.nextCursor, null);

    await getDb()!.collection('audioTracks').updateOne(
        { _id: ids.trackOne },
        { $set: { uploadStatus: 'ready' } }
    );
    const reorderCursorResponse = await request(
        `/api/listener/v1/pages/home/items/${ids.gridItem}?limit=1`
    );
    const reorderCursor: any = await reorderCursorResponse.json();
    await getDb()!.collection('pages').updateOne({ slug: 'home' }, {
        $set: {
            'items.0.order': 1,
            'items.1.order': 0
        }
    });
    const staleAfterPageReorder = await request(
        `/api/listener/v1/pages/home/items/${ids.gridItem}?limit=1&cursor=${encodeURIComponent(reorderCursor.nextCursor)}`
    );
    assert.equal(staleAfterPageReorder.status, 409);
    assert.equal((await staleAfterPageReorder.json() as any).code, 'stale_collection_cursor');

    await getDb()!.collection('pages').updateOne({ slug: 'home' }, {
        $set: {
            'items.0.order': 0,
            'items.1.order': 1
        }
    });
    const collectionCursorResponse = await request(
        `/api/listener/v1/pages/home/items/${ids.gridItem}?limit=1`
    );
    const collectionCursor: any = await collectionCursorResponse.json();
    await getDb()!.collection('contentCollections').updateOne(
        { _id: ids.gridCollection },
        { $set: { 'items.2.order': 0 } }
    );
    const staleAfterCollectionChange = await request(
        `/api/listener/v1/pages/home/items/${ids.gridItem}?limit=1&cursor=${encodeURIComponent(collectionCursor.nextCursor)}`
    );
    assert.equal(staleAfterCollectionChange.status, 409);
    assert.equal((await staleAfterCollectionChange.json() as any).code, 'stale_collection_cursor');

    await getDb()!.collection('pages').updateOne(
        { slug: 'home' },
        { $pull: { items: { itemId: ids.listItem.toHexString() } } } as any
    );
    const deletedPageItem = await request(
        `/api/listener/v1/pages/home/items/${ids.listItem}?cursor=${encodeURIComponent(firstList.nextCursor)}`
    );
    assert.equal(deletedPageItem.status, 404);
});
