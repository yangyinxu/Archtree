import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { ObjectId } from 'mongodb';
import { getDb } from '../src/infrastructure/database';
import { AudioTrack } from '../src/models/audioTrack';
import { Playlist, playlistRequestFingerprint } from '../src/models/playlist';
import { cleanupDeletedContentReferences } from '../src/services/contentReferenceService';
import { reconcileContentReferences } from '../src/services/contentReferenceReconciliationService';
import {
    cleanupAudioTrackPlaylistReferenceBatch
} from '../src/services/playlistLifecycleService';
import {
    MongoReplicaSetHarness,
    startMongoReplicaSet
} from './support/mongoReplicaSet';

let harness: MongoReplicaSetHarness | undefined;

before(async () => {
    harness = await startMongoReplicaSet('archtree-playlist-lifecycle-test');
});

beforeEach(async () => {
    await Promise.all([
        'albums',
        'accountMutations',
        'audioTracks',
        'artists',
        'carousels',
        'playlists',
        'users',
        'userActivity',
        'userSaves'
    ].map(collection => getDb()!.collection(collection).deleteMany({})));
});

after(async () => {
    await harness?.stop();
});

test('Soundtrack cleanup is bounded, resumable, revisioned, and idempotent', async () => {
    const audioTrackId = new ObjectId().toString();
    const otherAudioTrackId = new ObjectId().toString();
    const firstPlaylistId = new ObjectId('000000000000000000000001');
    const secondPlaylistId = new ObjectId('000000000000000000000002');
    const unrelatedPlaylistId = new ObjectId('000000000000000000000003');
    await getDb()!.collection('playlists').insertMany([
        {
            _id: firstPlaylistId,
            ownerUserId: new ObjectId().toString(),
            name: 'First',
            items: [
                {
                    itemId: 'first-target',
                    audioTrackId: ObjectId.createFromHexString(audioTrackId),
                    addedAt: new Date()
                },
                { itemId: 'first-other', audioTrackId: otherAudioTrackId, addedAt: new Date() }
            ],
            revision: 1,
            createdAt: new Date(),
            updatedAt: new Date()
        },
        {
            _id: secondPlaylistId,
            ownerUserId: new ObjectId().toString(),
            name: 'Second',
            items: [{
                itemId: 'second-target',
                audioTrackId: audioTrackId.toUpperCase(),
                addedAt: new Date()
            }],
            revision: 5,
            createdAt: new Date(),
            updatedAt: new Date()
        },
        {
            _id: unrelatedPlaylistId,
            ownerUserId: new ObjectId().toString(),
            name: 'Unrelated',
            items: [{ itemId: 'unrelated', audioTrackId: otherAudioTrackId, addedAt: new Date() }],
            revision: 9,
            createdAt: new Date(),
            updatedAt: new Date()
        }
    ]);

    const firstBatch = await cleanupAudioTrackPlaylistReferenceBatch(audioTrackId, 1);

    assert.deepEqual(firstBatch, { playlistsUpdated: 1, hasMore: true });
    const afterFirstBatch = await getDb()!.collection('playlists').findOne({
        _id: firstPlaylistId
    });
    assert.equal(afterFirstBatch!.revision, 2);
    assert.deepEqual(
        afterFirstBatch!.items.map((item: any) => item.itemId),
        ['first-other']
    );

    await cleanupDeletedContentReferences('audioTrack', audioTrackId);
    const afterRetry = await getDb()!.collection('playlists').find().sort({ _id: 1 }).toArray();
    assert.deepEqual(afterRetry.map(playlist => playlist.revision), [2, 6, 9]);
    assert.equal(
        afterRetry.some(playlist => playlist.items.some(
            (item: any) => String(item.audioTrackId).toLowerCase() === audioTrackId
        )),
        false
    );

    await cleanupDeletedContentReferences('audioTrack', audioTrackId);
    const afterIdempotentRetry = await getDb()!.collection('playlists')
        .find()
        .sort({ _id: 1 })
        .toArray();
    assert.deepEqual(afterIdempotentRetry.map(playlist => playlist.revision), [2, 6, 9]);
});

test('Playlist Add and the deleting transition serialize on the Soundtrack write fence', async () => {
    const ownerId = new ObjectId();
    const playlistId = new ObjectId();
    const audioTrackId = new ObjectId();
    await Promise.all([
        getDb()!.collection('users').insertOne({
            _id: ownerId,
            email: 'playlist-race-owner@example.com',
            role: 'user'
        }),
        getDb()!.collection('playlists').insertOne({
            _id: playlistId,
            ownerUserId: ownerId.toString(),
            name: 'Race',
            items: [],
            revision: 1,
            createdAt: new Date(),
            updatedAt: new Date()
        }),
        getDb()!.collection('audioTracks').insertOne({
            _id: audioTrackId,
            title: 'Race soundtrack',
            uploadStatus: 'ready',
            s3Key: audioTrackId.toString(),
            playlistReferenceRevision: 0
        })
    ]);
    const fingerprint = playlistRequestFingerprint('playlist.item.add', {
        playlistId: playlistId.toString(),
        audioTrackId: audioTrackId.toString(),
        position: null
    });

    const [addResult, deletingResult] = await Promise.allSettled([
        Playlist.addItem(
            ownerId.toString(),
            playlistId.toString(),
            audioTrackId.toString(),
            undefined,
            1,
            'playlist-add-delete-race-key',
            fingerprint
        ),
        AudioTrack.updateById(audioTrackId.toString(), {
            uploadStatus: 'deleting',
            uploadUpdatedAt: new Date()
        })
    ]);

    assert.equal(deletingResult.status, 'fulfilled');
    const track = await getDb()!.collection('audioTracks').findOne({ _id: audioTrackId });
    assert.equal(track!.uploadStatus, 'deleting');
    const playlistBeforeCleanup = await getDb()!.collection('playlists').findOne({
        _id: playlistId
    });
    if (addResult.status === 'fulfilled') {
        assert.equal(playlistBeforeCleanup!.items.length, 1);
    } else {
        assert.equal(playlistBeforeCleanup!.items.length, 0);
        assert.equal(
            await getDb()!.collection('accountMutations').countDocuments({
                ownerUserId: ownerId.toString()
            }),
            0
        );
    }

    await cleanupDeletedContentReferences('audioTrack', audioTrackId.toString());
    const playlistAfterCleanup = await getDb()!.collection('playlists').findOne({
        _id: playlistId
    });
    assert.equal(playlistAfterCleanup!.items.length, 0);
});

test('Soundtrack cleanup and Playlist reorder cannot resurrect a deleted membership', async () => {
    const ownerId = new ObjectId();
    const playlistId = new ObjectId();
    const deletingTrackId = new ObjectId();
    const retainedTrackId = new ObjectId();
    const deletingItemId = 'cleanup-reorder-deleting';
    const retainedItemId = 'cleanup-reorder-retained';
    await Promise.all([
        getDb()!.collection('users').insertOne({
            _id: ownerId,
            email: 'playlist-cleanup-reorder@example.com',
            role: 'user'
        }),
        getDb()!.collection('playlists').insertOne({
            _id: playlistId,
            ownerUserId: ownerId.toHexString(),
            name: 'Cleanup reorder race',
            items: [
                { itemId: deletingItemId, audioTrackId: deletingTrackId.toHexString(), addedAt: new Date() },
                { itemId: retainedItemId, audioTrackId: retainedTrackId.toHexString(), addedAt: new Date() }
            ],
            revision: 1,
            createdAt: new Date(),
            updatedAt: new Date()
        })
    ]);
    const desiredOrder = [retainedItemId, deletingItemId];

    const [reorderResult, cleanupResult] = await Promise.allSettled([
        Playlist.reorderItems(
            ownerId.toHexString(),
            playlistId.toHexString(),
            desiredOrder,
            1,
            'cleanup-reorder-race',
            playlistRequestFingerprint('playlist.item.reorder', {
                playlistId: playlistId.toHexString(),
                itemIds: desiredOrder,
                expectedRevision: 1
            })
        ),
        cleanupDeletedContentReferences('audioTrack', deletingTrackId.toHexString())
    ]);

    assert.equal(cleanupResult.status, 'fulfilled');
    const playlist = await getDb()!.collection('playlists').findOne({ _id: playlistId });
    assert.deepEqual(
        playlist!.items.map((item: any) => item.itemId),
        [retainedItemId]
    );
    assert.equal(playlist!.revision >= 2, true);
    if (reorderResult.status === 'rejected') {
        assert.equal(
            (reorderResult.reason as any)?.code,
            'playlist_revision_conflict'
        );
    }
});

test('content-reference reconciliation reports dangling Playlist items and owners read-only', async () => {
    const ownerId = new ObjectId();
    const missingOwnerId = new ObjectId();
    const readyTrackId = new ObjectId();
    const missingTrackId = new ObjectId();
    const stalledTrackId = new ObjectId();
    const playlistId = new ObjectId();
    const ownerlessPlaylistId = new ObjectId();
    const deletedPlaylistId = new ObjectId();
    await Promise.all([
        getDb()!.collection('users').insertOne({
            _id: ownerId,
            email: 'playlist-owner@example.com',
            role: 'user'
        }),
        getDb()!.collection('audioTracks').insertMany([
            { _id: readyTrackId, uploadStatus: 'ready' },
            {
                _id: stalledTrackId,
                uploadStatus: 'deleteFailed',
                referenceCleanupStatus: 'failed',
                referenceCleanupUpdatedAt: new Date('2026-08-04T12:00:00.000Z')
            }
        ]),
        getDb()!.collection('playlists').insertMany([
            {
                _id: playlistId,
                ownerUserId: ownerId.toString(),
                name: 'Audited',
                items: [
                    { itemId: 'ready-item', audioTrackId: readyTrackId.toString() },
                    { itemId: 'dangling-item', audioTrackId: missingTrackId.toString() }
                ],
                revision: 1
            },
            {
                _id: ownerlessPlaylistId,
                ownerUserId: missingOwnerId.toString(),
                name: 'Missing owner',
                items: [],
                revision: 1
            }
        ]),
        getDb()!.collection('accountMutations').insertMany([
            {
                _id: 'valid-receipt',
                ownerUserId: ownerId.toString(),
                idempotencyKeyHash: 'valid-receipt-hash',
                operation: 'playlist.rename',
                targetId: playlistId.toString(),
                status: 'completed',
                response: { statusCode: 200, kind: 'playlist', playlistId: playlistId.toString() }
            },
            {
                _id: 'missing-owner-receipt',
                ownerUserId: missingOwnerId.toString(),
                idempotencyKeyHash: 'missing-owner-receipt-hash',
                operation: 'playlist.delete',
                targetId: deletedPlaylistId.toString(),
                status: 'completed',
                response: { statusCode: 204, kind: 'deleted', playlistId: deletedPlaylistId.toString() }
            },
            {
                _id: 'owner-mismatch-receipt',
                ownerUserId: ownerId.toString(),
                idempotencyKeyHash: 'owner-mismatch-receipt-hash',
                operation: 'playlist.rename',
                targetId: ownerlessPlaylistId.toString(),
                status: 'completed',
                response: { statusCode: 200, kind: 'playlist', playlistId: ownerlessPlaylistId.toString() }
            },
            {
                _id: 'malformed-target-receipt',
                ownerUserId: ownerId.toString(),
                idempotencyKeyHash: 'malformed-target-receipt-hash',
                operation: 'playlist.rename',
                targetId: 'not-an-object-id',
                status: 'completed',
                response: { statusCode: 200, kind: 'playlist', playlistId: playlistId.toString() }
            },
            {
                _id: 'missing-target-receipt',
                ownerUserId: ownerId.toString(),
                idempotencyKeyHash: 'missing-target-receipt-hash',
                operation: 'playlist.rename',
                status: 'completed',
                response: { statusCode: 200, kind: 'playlist', playlistId: playlistId.toString() }
            },
            {
                _id: 'deleted-target-receipt',
                ownerUserId: ownerId.toString(),
                idempotencyKeyHash: 'deleted-target-receipt-hash',
                operation: 'playlist.delete',
                targetId: deletedPlaylistId.toString(),
                status: 'completed',
                response: { statusCode: 204, kind: 'deleted', playlistId: deletedPlaylistId.toString() }
            }
        ])
    ]);

    const report = await reconcileContentReferences();

    assert.equal(report.readOnly, true);
    assert.deepEqual(report.danglingPlaylistItems, [{
        playlistId: playlistId.toString(),
        itemId: 'dangling-item',
        audioTrackId: missingTrackId.toString()
    }]);
    assert.deepEqual(report.missingPlaylistOwners, [{
        playlistId: ownerlessPlaylistId.toString(),
        ownerUserId: missingOwnerId.toString()
    }]);
    assert.deepEqual(
        report.stalledAudioTrackReferenceCleanup.map(item => ({
            audioTrackId: item.audioTrackId,
            referenceCleanupStatus: item.referenceCleanupStatus
        })),
        [{
            audioTrackId: stalledTrackId.toString(),
            referenceCleanupStatus: 'failed'
        }]
    );
    assert.deepEqual(report.invalidAccountMutationOwners, [{
        mutationId: 'missing-owner-receipt',
        ownerUserId: missingOwnerId.toString()
    }]);
    assert.deepEqual(
        report.invalidAccountMutationTargets
            .map(item => ({
                mutationId: item.mutationId,
                reason: item.reason
            }))
            .sort((left, right) => left.mutationId.localeCompare(right.mutationId)),
        [
            { mutationId: 'malformed-target-receipt', reason: 'malformed' },
            { mutationId: 'missing-target-receipt', reason: 'missing' },
            { mutationId: 'owner-mismatch-receipt', reason: 'ownerMismatch' }
        ]
    );
    assert.equal(
        await getDb()!.collection('playlists').countDocuments({}),
        2
    );
});

test('bounded reconciliation verifies Playlist owners and Soundtracks beyond the source scan', async () => {
    const previousLimit = process.env.MAX_RECONCILIATION_OBJECTS;
    process.env.MAX_RECONCILIATION_OBJECTS = '1';
    const firstOwnerId = new ObjectId();
    const referencedOwnerId = new ObjectId();
    const missingOwnerId = new ObjectId();
    const firstTrackId = new ObjectId();
    const referencedTrackId = new ObjectId();
    const missingTrackId = new ObjectId();
    const playlistId = new ObjectId();
    try {
        await Promise.all([
            getDb()!.collection('users').insertMany([
                { _id: firstOwnerId, email: 'first-owner@example.com', role: 'user' },
                { _id: referencedOwnerId, email: 'referenced-owner@example.com', role: 'user' }
            ]),
            getDb()!.collection('audioTracks').insertMany([
                { _id: firstTrackId, uploadStatus: 'ready' },
                { _id: referencedTrackId, uploadStatus: 'ready' }
            ]),
            getDb()!.collection('playlists').insertOne({
                _id: playlistId,
                ownerUserId: referencedOwnerId.toString(),
                name: 'Beyond bounded source sets',
                items: [
                    { itemId: 'existing-item', audioTrackId: referencedTrackId.toString() },
                    { itemId: 'missing-item', audioTrackId: missingTrackId.toString() }
                ],
                revision: 1
            }),
            getDb()!.collection('accountMutations').insertOne({
                _id: 'bounded-existing-owner-receipt',
                ownerUserId: referencedOwnerId.toString(),
                operation: 'playlist.rename',
                targetId: playlistId.toString(),
                status: 'completed',
                response: { statusCode: 200, kind: 'playlist', playlistId: playlistId.toString() }
            })
        ]);

        const report = await reconcileContentReferences();

        assert.equal(report.limit, 1);
        assert.equal(report.truncated, true);
        assert.deepEqual(report.missingPlaylistOwners, []);
        assert.deepEqual(report.invalidAccountMutationOwners, []);
        assert.deepEqual(report.danglingPlaylistItems, [{
            playlistId: playlistId.toString(),
            itemId: 'missing-item',
            audioTrackId: missingTrackId.toString()
        }]);

        await getDb()!.collection('playlists').updateOne(
            { _id: playlistId },
            { $set: { ownerUserId: missingOwnerId.toString() } }
        );
        const missingOwnerReport = await reconcileContentReferences();
        assert.deepEqual(missingOwnerReport.missingPlaylistOwners, [{
            playlistId: playlistId.toString(),
            ownerUserId: missingOwnerId.toString()
        }]);
        assert.deepEqual(missingOwnerReport.danglingPlaylistItems, [{
            playlistId: playlistId.toString(),
            itemId: 'missing-item',
            audioTrackId: missingTrackId.toString()
        }]);
    } finally {
        if (previousLimit === undefined) {
            delete process.env.MAX_RECONCILIATION_OBJECTS;
        } else {
            process.env.MAX_RECONCILIATION_OBJECTS = previousLimit;
        }
    }
});
