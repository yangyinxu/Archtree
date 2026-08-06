import assert from 'node:assert/strict';
import { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import jwt from 'jsonwebtoken';
import { ObjectId } from 'mongodb';

import { createApp } from '../src/app';
import { getDb } from '../src/infrastructure/database';
import {
    ACCOUNT_MUTATION_COLLECTION,
    MAX_PLAYLIST_ITEMS,
    MAX_PLAYLIST_MEMBERSHIP_TRACK_IDS,
    MAX_PLAYLISTS_PER_ACCOUNT,
    PLAYLIST_COLLECTION
} from '../src/models/playlist';
import {
    MongoReplicaSetHarness,
    startMongoReplicaSet
} from './support/mongoReplicaSet';

interface TestAccount {
    id: ObjectId;
    email: string;
    sessionId: ObjectId;
    token: string;
}

interface ApiOptions {
    method?: string;
    body?: unknown;
    idempotencyKey?: string;
    ifMatch?: string;
    authentication?: 'bearer' | 'cookie';
    viewerId?: string | null;
}

let harness: MongoReplicaSetHarness | undefined;
let server: Server | undefined;
let baseUrl = '';
let listener: TestAccount;
let otherListener: TestAccount;

const readyTrackOne = new ObjectId();
const readyTrackTwo = new ObjectId();
const pendingTrack = new ObjectId();
const deletingTrack = new ObjectId();
const artistId = new ObjectId();
const albumId = new ObjectId();

const closeServer = (target?: Server) => new Promise<void>((resolve, reject) => {
    if (!target) return resolve();
    target.close((error) => error ? reject(error) : resolve());
});

const createAccountFixture = async (email: string): Promise<TestAccount> => {
    const id = new ObjectId();
    const sessionId = new ObjectId();
    await Promise.all([
        getDb()!.collection('users').insertOne({
            _id: id,
            email,
            username: email.split('@', 1)[0],
            password: 'unused',
            posts: [],
            role: 'user'
        }),
        getDb()!.collection('authSessions').insertOne({
            _id: sessionId,
            userId: id.toHexString(),
            refreshTokenHash: `playlist-${sessionId.toHexString()}`,
            createdAt: new Date(),
            updatedAt: new Date(),
            expiresAt: new Date(Date.now() + 10 * 60_000)
        })
    ]);
    return {
        id,
        email,
        sessionId,
        token: jwt.sign({
            userId: id.toHexString(),
            email,
            role: 'user',
            sessionId: sessionId.toHexString(),
            tokenType: 'access'
        }, process.env.JWT_SECRET!, { expiresIn: 10 * 60 })
    };
};

const apiRequest = (
    account: TestAccount,
    pathname: string,
    options: ApiOptions = {}
) => {
    const authentication = options.authentication ?? 'bearer';
    const headers: Record<string, string> = authentication === 'bearer'
        ? { Authorization: `Bearer ${account.token}` }
        : {
            Cookie: `session_token=${encodeURIComponent(account.token)}`,
            Origin: baseUrl,
            'Sec-Fetch-Site': 'same-origin',
            ...(options.viewerId === null
                ? {}
                : { 'X-Finitude-Account-Viewer': options.viewerId ?? account.id.toHexString() })
        };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
    if (options.ifMatch) headers['If-Match'] = options.ifMatch;
    return fetch(`${baseUrl}${pathname}`, {
        method: options.method ?? 'GET',
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
    });
};

const createPlaylist = async (
    account: TestAccount,
    name: string,
    key: string,
    authentication: 'bearer' | 'cookie' = 'bearer'
) => {
    const response = await apiRequest(account, '/content/me/playlists', {
        method: 'POST',
        body: { name },
        idempotencyKey: key,
        authentication
    });
    const body: any = await response.json();
    assert.equal(response.status, 201, JSON.stringify(body));
    return { response, body };
};

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

const expectSafePlaylist = (payload: unknown) => {
    const keys = allObjectKeys(payload);
    for (const forbidden of [
        'ownerUserId',
        'createdBy',
        'updatedBy',
        'coverArtId',
        's3Key',
        'uploadStatus',
        'uploadError',
        'playlistReferenceRevision'
    ]) {
        assert.equal(keys.has(forbidden), false, `Playlist response exposed ${forbidden}`);
    }
};

before(async () => {
    harness = await startMongoReplicaSet('archtree-playlist-test');
    [listener, otherListener] = await Promise.all([
        createAccountFixture('playlist-listener@example.com'),
        createAccountFixture('playlist-other@example.com')
    ]);
    await Promise.all([
        getDb()!.collection('artists').insertOne({
            _id: artistId,
            name: 'Playlist Artist',
            albumIds: [albumId.toHexString()]
        }),
        getDb()!.collection('albums').insertOne({
            _id: albumId,
            title: 'Playlist Album',
            coverArtUrl: '/album-cover.jpg',
            audioTrackIds: [readyTrackOne.toHexString(), readyTrackTwo.toHexString()]
        }),
        getDb()!.collection('audioTracks').insertMany([
            {
                _id: readyTrackOne,
                title: 'Ready One',
                artistIds: [artistId.toHexString()],
                albumId: albumId.toHexString(),
                duration: '03:12',
                uploadStatus: 'ready',
                s3Key: readyTrackOne.toHexString(),
                createdBy: 'private-provenance'
            },
            {
                _id: readyTrackTwo,
                title: 'Ready Two',
                artistIds: [artistId.toHexString()],
                albumId: albumId.toHexString(),
                duration: '04:03',
                coverArtUrl: '/track-cover.jpg',
                uploadStatus: 'ready',
                s3Key: readyTrackTwo.toHexString()
            },
            {
                _id: pendingTrack,
                title: 'Pending',
                uploadStatus: 'pending',
                s3Key: 'pending.mp3'
            },
            {
                _id: deletingTrack,
                title: 'Deleting',
                uploadStatus: 'deleting',
                s3Key: 'deleting.mp3'
            }
        ])
    ]);

    const app = createApp({
        listenerDistPath: path.join(os.tmpdir(), 'archtree-playlist-missing')
    });
    server = await new Promise<Server>((resolve) => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    baseUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(async () => {
    await Promise.all([
        getDb()!.collection(PLAYLIST_COLLECTION).deleteMany({}),
        getDb()!.collection(ACCOUNT_MUTATION_COLLECTION).deleteMany({}),
        getDb()!.collection('users').updateMany(
            { _id: { $in: [listener.id, otherListener.id] } },
            { $unset: { listenerMutationRevision: '' } }
        ),
        getDb()!.collection('audioTracks').updateMany(
            { _id: { $in: [readyTrackOne, readyTrackTwo, pendingTrack, deletingTrack] } },
            { $unset: { playlistReferenceRevision: '' } }
        )
    ]);
    await Promise.all([
        getDb()!.collection('audioTracks').updateMany(
            { _id: { $in: [readyTrackOne, readyTrackTwo] } },
            { $set: { uploadStatus: 'ready' } }
        ),
        getDb()!.collection('audioTracks').updateOne(
            { _id: pendingTrack },
            { $set: { uploadStatus: 'pending' } }
        ),
        getDb()!.collection('audioTracks').updateOne(
            { _id: deletingTrack },
            { $set: { uploadStatus: 'deleting' } }
        )
    ]);
});

after(async () => {
    await closeServer(server);
    await harness?.stop();
});

test('Playlist routes support Bearer and cookie auth while binding cookie requests to the viewer', async () => {
    const anonymous = await fetch(`${baseUrl}/content/me/playlists`);
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.headers.get('cache-control'), 'private, no-store');

    const missingKey = await apiRequest(listener, '/content/me/playlists', {
        method: 'POST',
        body: { name: 'Missing key' }
    });
    assert.equal(missingKey.status, 428);
    assert.equal((await missingKey.json() as any).code, 'idempotency_key_required');

    const missingViewer = await apiRequest(listener, '/content/me/playlists', {
        method: 'POST',
        body: { name: 'Cookie Playlist' },
        idempotencyKey: 'cookie-missing-viewer',
        authentication: 'cookie',
        viewerId: null
    });
    assert.equal(missingViewer.status, 409);
    assert.match(missingViewer.headers.get('cache-control') ?? '', /(?:^|,\s*)no-store(?:,|$)/);
    assert.equal((await missingViewer.json() as any).code, 'account_viewer_mismatch');

    const staleViewer = await apiRequest(listener, '/content/me/playlists', {
        method: 'POST',
        body: { name: 'Cookie Playlist' },
        idempotencyKey: 'cookie-stale-viewer',
        authentication: 'cookie',
        viewerId: otherListener.id.toHexString()
    });
    assert.equal(staleViewer.status, 409);

    const created = await createPlaylist(
        listener,
        'Cookie Playlist',
        'cookie-create',
        'cookie'
    );
    assert.equal(created.response.headers.get('etag'), '"1"');
    assert.equal(created.response.headers.get('cache-control'), 'private, no-store');
    assert.match(created.response.headers.get('vary') ?? '', /Cookie/);
    assert.match(created.response.headers.get('vary') ?? '', /Authorization/);

    const missingViewerRead = await apiRequest(listener, '/content/me/playlists', {
        authentication: 'cookie',
        viewerId: null
    });
    assert.equal(missingViewerRead.status, 409);
    assert.equal((await missingViewerRead.json() as any).code, 'account_viewer_mismatch');

    const staleViewerRead = await apiRequest(listener, '/content/me/playlists', {
        authentication: 'cookie',
        viewerId: otherListener.id.toHexString()
    });
    assert.equal(staleViewerRead.status, 409);

    const cookieRead = await apiRequest(listener, '/content/me/playlists', {
        authentication: 'cookie'
    });
    assert.equal(cookieRead.status, 200);
    assert.equal((await cookieRead.json() as any).items.length, 1);
});

test('the emergency Playlist flag stops traffic without deleting private data', async () => {
    const { body: created } = await createPlaylist(listener, 'Retained while disabled', 'flag-create');
    const previous = process.env.FINITUDE_PLAYLISTS_ENABLED;
    process.env.FINITUDE_PLAYLISTS_ENABLED = 'false';
    try {
        const disabled = await apiRequest(listener, '/content/me/playlists');
        assert.equal(disabled.status, 503);
        assert.equal((await disabled.json() as any).code, 'playlist_unavailable');
        assert.equal(disabled.headers.get('cache-control'), 'private, no-store');
        assert.equal(
            await getDb()!.collection(PLAYLIST_COLLECTION).countDocuments({ _id: new ObjectId(created.id) }),
            1
        );
    } finally {
        if (previous === undefined) delete process.env.FINITUDE_PLAYLISTS_ENABLED;
        else process.env.FINITUDE_PLAYLISTS_ENABLED = previous;
    }

    const restored = await apiRequest(listener, `/content/me/playlists/${created.id}`);
    assert.equal(restored.status, 200);
});

test('owner-only CRUD enforces revisions and compact idempotency replay semantics', async () => {
    const created = await createPlaylist(listener, 'First name', 'create-once');
    const playlistId = created.body.id;
    assert.deepEqual(Object.keys(created.body).sort(), [
        'artworkUrl',
        'createdAt',
        'id',
        'itemCount',
        'items',
        'name',
        'revision',
        'updatedAt'
    ]);
    assert.equal(created.body.artworkUrl, '');
    expectSafePlaylist(created.body);

    const createReplay = await apiRequest(listener, '/content/me/playlists', {
        method: 'POST',
        body: { name: 'First name' },
        idempotencyKey: 'create-once'
    });
    assert.equal(createReplay.status, 201);
    assert.equal((await createReplay.json() as any).id, playlistId);

    const reusedKey = await apiRequest(listener, '/content/me/playlists', {
        method: 'POST',
        body: { name: 'Different input' },
        idempotencyKey: 'create-once'
    });
    assert.equal(reusedKey.status, 409);
    assert.equal((await reusedKey.json() as any).code, 'idempotency_key_reused');

    const privateRead = await apiRequest(otherListener, `/content/me/playlists/${playlistId}`);
    assert.equal(privateRead.status, 404);
    assert.equal((await privateRead.json() as any).code, 'playlist_not_found');

    const missingRevision = await apiRequest(listener, `/content/me/playlists/${playlistId}`, {
        method: 'PATCH',
        body: { name: 'Second name' },
        idempotencyKey: 'rename-missing-revision'
    });
    assert.equal(missingRevision.status, 428);

    const staleRevision = await apiRequest(listener, `/content/me/playlists/${playlistId}`, {
        method: 'PATCH',
        body: { name: 'Second name' },
        idempotencyKey: 'rename-stale',
        ifMatch: '"9"'
    });
    assert.equal(staleRevision.status, 409);
    const staleBody: any = await staleRevision.json();
    assert.equal(staleBody.code, 'playlist_revision_conflict');
    assert.equal(staleBody.currentRevision, 1);
    assert.equal(staleBody.playlist.id, playlistId);
    expectSafePlaylist(staleBody);

    const renamed = await apiRequest(listener, `/content/me/playlists/${playlistId}`, {
        method: 'PATCH',
        body: { name: 'Second name' },
        idempotencyKey: 'rename-correct',
        ifMatch: '"1"'
    });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.headers.get('etag'), '"2"');
    assert.equal((await renamed.json() as any).revision, 2);

    const replayAfterChange = await apiRequest(listener, '/content/me/playlists', {
        method: 'POST',
        body: { name: 'First name' },
        idempotencyKey: 'create-once'
    });
    assert.equal(replayAfterChange.status, 201);
    const currentReplay: any = await replayAfterChange.json();
    assert.equal(currentReplay.name, 'Second name');
    assert.equal(currentReplay.revision, 2, 'compact receipts rehydrate the current detail');

    const concurrent = await Promise.all([
        apiRequest(listener, `/content/me/playlists/${playlistId}`, {
            method: 'PATCH',
            body: { name: 'Concurrent A' },
            idempotencyKey: 'rename-concurrent-a',
            ifMatch: '"2"'
        }),
        apiRequest(listener, `/content/me/playlists/${playlistId}`, {
            method: 'PATCH',
            body: { name: 'Concurrent B' },
            idempotencyKey: 'rename-concurrent-b',
            ifMatch: '"2"'
        })
    ]);
    assert.deepEqual(concurrent.map((response) => response.status).sort(), [200, 409]);

    const current = await apiRequest(listener, `/content/me/playlists/${playlistId}`);
    const currentBody: any = await current.json();
    assert.equal(currentBody.revision, 3);

    const unknownDeleteBody = await apiRequest(listener, `/content/me/playlists/${playlistId}`, {
        method: 'DELETE',
        body: { unexpected: true },
        idempotencyKey: 'delete-unknown-body',
        ifMatch: '"3"'
    });
    assert.equal(unknownDeleteBody.status, 400);

    const deleted = await apiRequest(listener, `/content/me/playlists/${playlistId}`, {
        method: 'DELETE',
        body: {},
        idempotencyKey: 'delete-correct',
        ifMatch: '"3"'
    });
    assert.equal(deleted.status, 204);
    assert.equal(await deleted.text(), '');

    const deleteReplay = await apiRequest(listener, `/content/me/playlists/${playlistId}`, {
        method: 'DELETE',
        body: {},
        idempotencyKey: 'delete-correct',
        ifMatch: '"3"'
    });
    assert.equal(deleteReplay.status, 204, 'delete receipts replay after the record is gone');

    const createReplayAfterDelete = await apiRequest(listener, '/content/me/playlists', {
        method: 'POST',
        body: { name: 'First name' },
        idempotencyKey: 'create-once'
    });
    assert.equal(
        createReplayAfterDelete.status,
        404,
        'a compact non-delete receipt cannot rehydrate detail after a later deletion'
    );

    const receipt: any = await getDb()!.collection(ACCOUNT_MUTATION_COLLECTION).findOne({
        operation: 'playlist.create'
    });
    assert.equal(receipt.idempotencyKeyHash.length, 64);
    assert.equal(JSON.stringify(receipt).includes('create-once'), false);
});

test('concurrent Create requests serialize both idempotency replay and the account quota', async () => {
    const sameKey = await Promise.all([
        apiRequest(listener, '/content/me/playlists', {
            method: 'POST',
            body: { name: 'One logical create' },
            idempotencyKey: 'same-concurrent-create'
        }),
        apiRequest(listener, '/content/me/playlists', {
            method: 'POST',
            body: { name: 'One logical create' },
            idempotencyKey: 'same-concurrent-create'
        })
    ]);
    assert.deepEqual(sameKey.map((response) => response.status), [201, 201]);
    const replayBodies = await Promise.all(sameKey.map((response) => response.json() as Promise<any>));
    assert.equal(replayBodies[0].id, replayBodies[1].id);
    assert.equal(await getDb()!.collection(PLAYLIST_COLLECTION).countDocuments({
        ownerUserId: listener.id.toHexString()
    }), 1);

    await Promise.all([
        getDb()!.collection(PLAYLIST_COLLECTION).deleteMany({
            ownerUserId: listener.id.toHexString()
        }),
        getDb()!.collection(ACCOUNT_MUTATION_COLLECTION).deleteMany({
            ownerUserId: listener.id.toHexString()
        })
    ]);
    const now = new Date();
    await getDb()!.collection(PLAYLIST_COLLECTION).insertMany(
        Array.from({ length: MAX_PLAYLISTS_PER_ACCOUNT - 1 }, (_, index) => ({
            _id: new ObjectId(),
            ownerUserId: listener.id.toHexString(),
            name: `Concurrent quota ${index}`,
            items: [],
            revision: 1,
            createdAt: now,
            updatedAt: now
        }))
    );

    const quotaRace = await Promise.all([
        apiRequest(listener, '/content/me/playlists', {
            method: 'POST',
            body: { name: 'Quota contender A' },
            idempotencyKey: 'quota-contender-a'
        }),
        apiRequest(listener, '/content/me/playlists', {
            method: 'POST',
            body: { name: 'Quota contender B' },
            idempotencyKey: 'quota-contender-b'
        })
    ]);
    assert.deepEqual(quotaRace.map((response) => response.status).sort(), [201, 409]);
    assert.equal(await getDb()!.collection(PLAYLIST_COLLECTION).countDocuments({
        ownerUserId: listener.id.toHexString()
    }), MAX_PLAYLISTS_PER_ACCOUNT);
});

test('membership writes require ready Soundtracks, preserve exact order, and expose safe DTOs', async () => {
    const { body: created } = await createPlaylist(listener, 'Members', 'members-create');
    const playlistPath = `/content/me/playlists/${created.id}`;

    const pending = await apiRequest(listener, `${playlistPath}/items`, {
        method: 'POST',
        body: { audioTrackId: pendingTrack.toHexString() },
        idempotencyKey: 'members-pending',
        ifMatch: '"1"'
    });
    assert.equal(pending.status, 404);
    assert.equal((await pending.json() as any).code, 'audio_track_not_found');
    assert.equal(await getDb()!.collection(ACCOUNT_MUTATION_COLLECTION).countDocuments({
        operation: 'playlist.item.add'
    }), 0, 'failed mutations leave no receipt or business write');

    const firstAdd = await apiRequest(listener, `${playlistPath}/items`, {
        method: 'POST',
        body: { audioTrackId: readyTrackOne.toHexString() },
        idempotencyKey: 'members-add-one',
        ifMatch: '"1"'
    });
    assert.equal(firstAdd.status, 200);
    const firstDetail: any = await firstAdd.json();
    assert.equal(firstDetail.revision, 2);
    assert.equal(firstDetail.items.length, 1);
    assert.equal(firstDetail.items[0].availability, 'ready');
    assert.equal(firstDetail.items[0].audioTrack.title, 'Ready One');
    assert.equal(firstDetail.items[0].audioTrack.artworkUrl, '/album-cover.jpg');
    assert.equal(firstDetail.artworkUrl, '/album-cover.jpg');
    expectSafePlaylist(firstDetail);
    assert.equal(
        (await getDb()!.collection('audioTracks').findOne({ _id: readyTrackOne }))
            ?.playlistReferenceRevision,
        1
    );

    const duplicate = await apiRequest(listener, `${playlistPath}/items`, {
        method: 'POST',
        body: { audioTrackId: readyTrackOne.toHexString() },
        idempotencyKey: 'members-add-duplicate',
        ifMatch: '"2"'
    });
    assert.equal(duplicate.status, 200);
    const duplicateDetail: any = await duplicate.json();
    assert.equal(duplicateDetail.revision, 2);
    assert.equal(duplicateDetail.items.length, 1);
    assert.equal(
        (await getDb()!.collection('audioTracks').findOne({ _id: readyTrackOne }))
            ?.playlistReferenceRevision,
        1,
        'a duplicate membership does not touch the track fence again'
    );

    const secondAdd = await apiRequest(listener, `${playlistPath}/items`, {
        method: 'POST',
        body: { audioTrackId: readyTrackTwo.toHexString(), position: 0 },
        idempotencyKey: 'members-add-two',
        ifMatch: '"2"'
    });
    assert.equal(secondAdd.status, 200);
    const secondDetail: any = await secondAdd.json();
    assert.equal(secondDetail.revision, 3);
    assert.deepEqual(
        secondDetail.items.map((item: any) => item.audioTrackId),
        [readyTrackTwo.toHexString(), readyTrackOne.toHexString()]
    );
    assert.equal(secondDetail.artworkUrl, '/track-cover.jpg');

    const artworkList = await apiRequest(listener, '/content/me/playlists?limit=100');
    const artworkListBody: any = await artworkList.json();
    assert.equal(artworkList.status, 200);
    assert.equal(artworkListBody.items.length, 1);
    assert.equal(artworkListBody.items[0].artworkUrl, '/track-cover.jpg');
    assert.deepEqual(Object.keys(artworkListBody.items[0]).sort(), [
        'artworkUrl',
        'createdAt',
        'id',
        'itemCount',
        'name',
        'revision',
        'updatedAt'
    ]);
    expectSafePlaylist(artworkListBody);

    await getDb()!.collection('audioTracks').updateOne(
        { _id: readyTrackTwo },
        { $set: { uploadStatus: 'deleting' } }
    );
    const unavailableRead = await apiRequest(listener, playlistPath);
    const unavailableDetail: any = await unavailableRead.json();
    assert.equal(unavailableDetail.revision, 3);
    assert.equal(unavailableDetail.items[0].availability, 'unavailable');
    assert.equal(unavailableDetail.items[0].audioTrack, null);
    assert.equal(
        unavailableDetail.artworkUrl,
        '/album-cover.jpg',
        'non-ready members cannot contribute Playlist artwork'
    );
    const unavailableList = await apiRequest(listener, '/content/me/playlists?limit=100');
    assert.equal((await unavailableList.json() as any).items[0].artworkUrl, '/album-cover.jpg');
    await getDb()!.collection('audioTracks').updateOne(
        { _id: readyTrackTwo },
        { $set: { uploadStatus: 'ready' } }
    );

    const deleting = await apiRequest(listener, `${playlistPath}/items`, {
        method: 'POST',
        body: { audioTrackId: deletingTrack.toHexString() },
        idempotencyKey: 'members-add-deleting',
        ifMatch: '"3"'
    });
    assert.equal(deleting.status, 404, 'a deleting Soundtrack cannot win the shared write fence');
    const afterDeleting = await apiRequest(listener, playlistPath);
    assert.equal((await afterDeleting.json() as any).revision, 3);

    const incompleteOrder = await apiRequest(listener, `${playlistPath}/items/order`, {
        method: 'PUT',
        body: { itemIds: [secondDetail.items[0].itemId] },
        idempotencyKey: 'members-bad-order',
        ifMatch: '"3"'
    });
    assert.equal(incompleteOrder.status, 400);
    assert.equal((await incompleteOrder.json() as any).code, 'invalid_playlist_order');

    const reordered = await apiRequest(listener, `${playlistPath}/items/order`, {
        method: 'PUT',
        body: { itemIds: [...secondDetail.items].reverse().map((item: any) => item.itemId) },
        idempotencyKey: 'members-reorder',
        ifMatch: '"3"'
    });
    assert.equal(reordered.status, 200);
    const reorderedDetail: any = await reordered.json();
    assert.equal(reorderedDetail.revision, 4);
    assert.deepEqual(
        reorderedDetail.items.map((item: any) => item.audioTrackId),
        [readyTrackOne.toHexString(), readyTrackTwo.toHexString()]
    );
    assert.equal(reorderedDetail.artworkUrl, '/album-cover.jpg');

    const itemId = reorderedDetail.items[0].itemId;
    const unknownRemoveBody = await apiRequest(listener, `${playlistPath}/items/${itemId}`, {
        method: 'DELETE',
        body: { unexpected: true },
        idempotencyKey: 'members-remove-unknown-body',
        ifMatch: '"4"'
    });
    assert.equal(unknownRemoveBody.status, 400);

    const removed = await apiRequest(listener, `${playlistPath}/items/${itemId}`, {
        method: 'DELETE',
        body: {},
        idempotencyKey: 'members-remove',
        ifMatch: '"4"'
    });
    assert.equal(removed.status, 200);
    const removedDetail: any = await removed.json();
    assert.equal(removedDetail.revision, 5);
    assert.deepEqual(
        removedDetail.items.map((item: any) => item.audioTrackId),
        [readyTrackTwo.toHexString()]
    );
    assert.equal(removedDetail.artworkUrl, '/track-cover.jpg');
});

test('membership lookup is owner-only, deterministic, strict, and bounded', async () => {
    const requestedWithoutMembership = new ObjectId();
    const ownerPlaylistIds = [new ObjectId(), new ObjectId()].sort((left, right) =>
        left.toHexString().localeCompare(right.toHexString())
    );
    const otherOwnerPlaylistId = new ObjectId();
    await getDb()!.collection(PLAYLIST_COLLECTION).insertMany([
        {
            _id: ownerPlaylistIds[1],
            ownerUserId: listener.id.toHexString(),
            name: 'Private second',
            items: [
                {
                    itemId: 'lookup-owner-second-one',
                    audioTrackId: readyTrackOne.toHexString(),
                    addedAt: new Date()
                },
                {
                    itemId: 'lookup-owner-second-two',
                    audioTrackId: readyTrackTwo.toHexString(),
                    addedAt: new Date()
                }
            ],
            revision: 1,
            createdAt: new Date(),
            updatedAt: new Date()
        },
        {
            _id: ownerPlaylistIds[0],
            ownerUserId: listener.id.toHexString(),
            name: 'Private first',
            items: [{
                itemId: 'lookup-owner-first-one',
                audioTrackId: readyTrackOne.toHexString(),
                addedAt: new Date()
            }],
            revision: 1,
            createdAt: new Date(),
            updatedAt: new Date()
        },
        {
            _id: otherOwnerPlaylistId,
            ownerUserId: otherListener.id.toHexString(),
            name: 'Other owner secret',
            items: [{
                itemId: 'lookup-other-one',
                audioTrackId: readyTrackOne.toHexString(),
                addedAt: new Date()
            }],
            revision: 1,
            createdAt: new Date(),
            updatedAt: new Date()
        }
    ]);

    const requestedIds = [
        readyTrackTwo.toHexString(),
        requestedWithoutMembership.toHexString(),
        readyTrackOne.toHexString()
    ];
    const response = await apiRequest(
        listener,
        `/content/me/playlists/memberships?audioTrackIds=${requestedIds.join(',')}`
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    const body: any = await response.json();
    assert.deepEqual(
        body.items.map((item: any) => item.audioTrackId),
        [...requestedIds].sort()
    );
    assert.deepEqual(
        body.items.find((item: any) => item.audioTrackId === readyTrackOne.toHexString())
            ?.playlistIds,
        ownerPlaylistIds.map((id) => id.toHexString())
    );
    assert.deepEqual(
        body.items.find((item: any) => item.audioTrackId === readyTrackTwo.toHexString())
            ?.playlistIds,
        [ownerPlaylistIds[1].toHexString()]
    );
    assert.deepEqual(
        body.items.find((item: any) => item.audioTrackId === requestedWithoutMembership.toHexString())
            ?.playlistIds,
        []
    );
    assert.deepEqual(Object.keys(body), ['items']);
    for (const item of body.items) {
        assert.deepEqual(Object.keys(item).sort(), ['audioTrackId', 'playlistIds']);
    }
    expectSafePlaylist(body);

    const otherOwner = await apiRequest(
        otherListener,
        `/content/me/playlists/memberships?audioTrackIds=${readyTrackOne.toHexString()}`
    );
    const otherBody: any = await otherOwner.json();
    assert.equal(otherOwner.status, 200);
    assert.deepEqual(otherBody.items[0].playlistIds, [otherOwnerPlaylistId.toHexString()]);

    const anonymous = await fetch(
        `${baseUrl}/content/me/playlists/memberships?audioTrackIds=${readyTrackOne.toHexString()}`
    );
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.headers.get('cache-control'), 'private, no-store');

    const invalidQueries = [
        '/content/me/playlists/memberships',
        '/content/me/playlists/memberships?audioTrackIds=',
        '/content/me/playlists/memberships?audioTrackIds=not-an-object-id',
        `/content/me/playlists/memberships?audioTrackIds=${readyTrackOne.toHexString()},${readyTrackOne.toHexString().toUpperCase()}`,
        `/content/me/playlists/memberships?audioTrackIds=${readyTrackOne.toHexString()}&unexpected=true`,
        `/content/me/playlists/memberships?audioTrackIds=${readyTrackOne.toHexString()}&audioTrackIds=${readyTrackTwo.toHexString()}`
    ];
    for (const pathname of invalidQueries) {
        const invalid = await apiRequest(listener, pathname);
        assert.equal(invalid.status, 400, pathname);
        assert.equal((await invalid.json() as any).code, 'invalid_audio_track_ids');
    }

    const atLimit = Array.from(
        { length: MAX_PLAYLIST_MEMBERSHIP_TRACK_IDS },
        () => new ObjectId().toHexString()
    );
    const accepted = await apiRequest(
        listener,
        `/content/me/playlists/memberships?audioTrackIds=${atLimit.join(',')}`
    );
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json() as any).items.length, MAX_PLAYLIST_MEMBERSHIP_TRACK_IDS);

    const overLimit = [...atLimit, new ObjectId().toHexString()];
    const bounded = await apiRequest(
        listener,
        `/content/me/playlists/memberships?audioTrackIds=${overLimit.join(',')}`
    );
    assert.equal(bounded.status, 400);
    assert.equal((await bounded.json() as any).code, 'invalid_audio_track_ids');
});

test('stable pagination, account quota, member cap, and required indexes are bounded', async () => {
    const sharedUpdatedAt = new Date('2026-08-04T12:00:00.000Z');
    const ids = [new ObjectId(), new ObjectId(), new ObjectId()].sort((left, right) =>
        left.toHexString().localeCompare(right.toHexString())
    );
    await getDb()!.collection(PLAYLIST_COLLECTION).insertMany(ids.map((_id, index) => ({
        _id,
        ownerUserId: listener.id.toHexString(),
        name: `Page ${index}`,
        items: [],
        revision: 1,
        createdAt: sharedUpdatedAt,
        updatedAt: sharedUpdatedAt
    })));

    const firstPage = await apiRequest(listener, '/content/me/playlists?limit=2');
    assert.equal(firstPage.status, 200);
    const firstBody: any = await firstPage.json();
    assert.deepEqual(firstBody.items.map((item: any) => item.id), [
        ids[2].toHexString(),
        ids[1].toHexString()
    ]);
    assert.ok(firstBody.nextCursor);
    const secondPage = await apiRequest(
        listener,
        `/content/me/playlists?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor)}`
    );
    const secondBody: any = await secondPage.json();
    assert.deepEqual(secondBody.items.map((item: any) => item.id), [ids[0].toHexString()]);
    assert.equal(secondBody.nextCursor, null);

    const invalidCursor = await apiRequest(listener, '/content/me/playlists?cursor=not-a-cursor');
    assert.equal(invalidCursor.status, 400);

    const remaining = MAX_PLAYLISTS_PER_ACCOUNT - ids.length;
    await getDb()!.collection(PLAYLIST_COLLECTION).insertMany(
        Array.from({ length: remaining }, (_, index) => ({
            _id: new ObjectId(),
            ownerUserId: listener.id.toHexString(),
            name: `Quota ${index}`,
            items: [],
            revision: 1,
            createdAt: new Date(),
            updatedAt: new Date()
        }))
    );
    const quota = await apiRequest(listener, '/content/me/playlists', {
        method: 'POST',
        body: { name: 'One too many' },
        idempotencyKey: 'quota-create'
    });
    assert.equal(quota.status, 409);
    assert.equal((await quota.json() as any).code, 'playlist_limit_reached');

    await getDb()!.collection(PLAYLIST_COLLECTION).deleteMany({
        ownerUserId: listener.id.toHexString()
    });
    const fullPlaylistId = new ObjectId();
    await getDb()!.collection(PLAYLIST_COLLECTION).insertOne({
        _id: fullPlaylistId,
        ownerUserId: listener.id.toHexString(),
        name: 'Full',
        items: Array.from({ length: MAX_PLAYLIST_ITEMS }, (_, index) => ({
            itemId: `item-${index}`,
            audioTrackId: new ObjectId().toHexString(),
            addedAt: new Date()
        })),
        revision: 1,
        createdAt: new Date(),
        updatedAt: new Date()
    });
    const hydratedMaximum = await apiRequest(
        listener,
        `/content/me/playlists/${fullPlaylistId.toHexString()}`
    );
    assert.equal(hydratedMaximum.status, 200);
    const hydratedMaximumBody: any = await hydratedMaximum.json();
    assert.equal(hydratedMaximumBody.items.length, MAX_PLAYLIST_ITEMS);
    assert.equal(
        hydratedMaximumBody.items.every((item: any) => (
            item.availability === 'unavailable' && item.audioTrack === null
        )),
        true
    );
    const full = await apiRequest(listener, `/content/me/playlists/${fullPlaylistId}/items`, {
        method: 'POST',
        body: { audioTrackId: readyTrackOne.toHexString() },
        idempotencyKey: 'full-add',
        ifMatch: '"1"'
    });
    assert.equal(full.status, 409);
    assert.equal((await full.json() as any).code, 'playlist_item_limit_reached');
    assert.equal(
        (await getDb()!.collection('audioTracks').findOne({ _id: readyTrackOne }))
            ?.playlistReferenceRevision,
        undefined,
        'the size guard runs before touching the ready-track fence'
    );

    const playlistIndexes = await getDb()!.collection(PLAYLIST_COLLECTION).listIndexes().toArray();
    assert.ok(playlistIndexes.some((index) =>
        JSON.stringify(index.key) === JSON.stringify({ ownerUserId: 1, updatedAt: -1, _id: -1 })
    ));
    const receiptIndexes = await getDb()!
        .collection(ACCOUNT_MUTATION_COLLECTION)
        .listIndexes()
        .toArray();
    assert.ok(receiptIndexes.some((index) => index.expireAfterSeconds === 0));
    assert.ok(receiptIndexes.some((index) => index.unique === true
        && index.key.ownerUserId === 1
        && index.key.idempotencyKeyHash === 1));
});

test('Playlist names are normalized, bounded, and may be duplicated', async () => {
    for (const name of ['', ' '.repeat(3), 'x'.repeat(101), 'line\nbreak']) {
        const response = await apiRequest(listener, '/content/me/playlists', {
            method: 'POST',
            body: { name },
            idempotencyKey: `invalid-name-${Buffer.from(name).toString('hex').slice(0, 20) || 'empty'}`
        });
        assert.equal(response.status, 400);
        assert.equal((await response.json() as any).code, 'invalid_playlist_name');
    }
    const unknownField = await apiRequest(listener, '/content/me/playlists', {
        method: 'POST',
        body: { name: 'Valid', visibility: 'public' },
        idempotencyKey: 'unknown-field'
    });
    assert.equal(unknownField.status, 400);

    const first = await createPlaylist(listener, '  Café  ', 'duplicate-name-one');
    const second = await createPlaylist(listener, 'Café', 'duplicate-name-two');
    assert.equal(first.body.name, 'Café');
    assert.equal(second.body.name, 'Café');
    assert.notEqual(first.body.id, second.body.id);
});
