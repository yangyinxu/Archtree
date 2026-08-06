import assert from 'node:assert/strict';
import test from 'node:test';

import {
    findIncompleteAudioTracks,
    findDuplicateAudioStorageKeys,
    isAudioStorageCandidateKey,
    isAudioStorageObjectKey
} from '../src/services/audioReconciliationService';
import { reconcileImageStorage } from '../src/services/imageReconciliationService';

test('audio reconciliation excludes both public-image and private-avatar namespaces', () => {
    assert.equal(isAudioStorageObjectKey('507f1f77bcf86cd799439011'), true);
    assert.equal(
        isAudioStorageObjectKey('audio/507f1f77bcf86cd799439011/507f1f77bcf86cd799439012'),
        true
    );
    assert.equal(isAudioStorageObjectKey('audio/catalog/track'), false);
    assert.equal(isAudioStorageObjectKey('images/cover-id'), false);
    assert.equal(isAudioStorageObjectKey('avatars/private-id'), false);
    assert.equal(isAudioStorageCandidateKey('audio/catalog/track'), true);
    assert.equal(isAudioStorageCandidateKey('images/cover-id'), false);
    assert.equal(isAudioStorageCandidateKey('avatars/private-id'), false);
});

test('audio reconciliation reports a shared raw key even when one track identity is invalid', () => {
    const firstTrackId = '507f1f77bcf86cd799439011';
    const secondTrackId = '507f1f77bcf86cd799439012';
    assert.deepEqual(findDuplicateAudioStorageKeys([
        { _id: firstTrackId, s3Key: firstTrackId },
        { _id: secondTrackId, s3Key: firstTrackId }
    ]), [{
        s3Key: firstTrackId,
        audioTrackIds: [firstTrackId, secondTrackId]
    }]);
});

test('audio reconciliation reports storage-ready pending and failed publication state', () => {
    const pendingId = '507f1f77bcf86cd799439011';
    const failedId = '507f1f77bcf86cd799439012';
    const readyId = '507f1f77bcf86cd799439013';
    const legacyId = '507f1f77bcf86cd799439014';
    const nullId = '507f1f77bcf86cd799439015';
    const emptyId = '507f1f77bcf86cd799439016';
    const unknownId = '507f1f77bcf86cd799439017';
    const now = new Date('2026-08-05T12:00:00.000Z');
    const incomplete = findIncompleteAudioTracks([
        {
            _id: pendingId,
            s3Key: pendingId,
            uploadStatus: 'ready',
            publicationStatus: 'pending',
            publicationUpdatedAt: now
        },
        {
            _id: failedId,
            s3Key: failedId,
            uploadStatus: 'ready',
            publicationStatus: 'failed',
            publicationUpdatedAt: now,
            publicationError: 'Album changed'
        },
        {
            _id: readyId,
            s3Key: readyId,
            uploadStatus: 'ready',
            publicationStatus: 'ready'
        },
        { _id: legacyId, s3Key: legacyId, uploadStatus: 'ready' },
        {
            _id: nullId,
            s3Key: nullId,
            uploadStatus: 'ready',
            publicationStatus: null
        },
        {
            _id: emptyId,
            s3Key: emptyId,
            uploadStatus: 'ready',
            publicationStatus: ''
        },
        {
            _id: unknownId,
            s3Key: unknownId,
            uploadStatus: 'ready',
            publicationStatus: 'unexpected'
        }
    ], new Set([
        pendingId,
        failedId,
        readyId,
        legacyId,
        nullId,
        emptyId,
        unknownId
    ]));

    assert.deepEqual(incomplete.map((track) => ({
        audioTrackId: track.audioTrackId,
        publicationStatus: track.publicationStatus,
        publicationUpdatedAt: track.publicationUpdatedAt,
        publicationError: track.publicationError,
        objectExists: track.objectExists
    })), [
        {
            audioTrackId: pendingId,
            publicationStatus: 'pending',
            publicationUpdatedAt: now,
            publicationError: '',
            objectExists: true
        },
        {
            audioTrackId: failedId,
            publicationStatus: 'failed',
            publicationUpdatedAt: now,
            publicationError: 'Album changed',
            objectExists: true
        },
        {
            audioTrackId: nullId,
            publicationStatus: 'null',
            publicationUpdatedAt: null,
            publicationError: '',
            objectExists: true
        },
        {
            audioTrackId: emptyId,
            publicationStatus: '',
            publicationUpdatedAt: null,
            publicationError: '',
            objectExists: true
        },
        {
            audioTrackId: unknownId,
            publicationStatus: 'unexpected',
            publicationUpdatedAt: null,
            publicationError: '',
            objectExists: true
        }
    ]);
});

test('image reconciliation audits cover art and private avatars without mutating either', async () => {
    const coverAttached = '507f1f77bcf86cd799439011';
    const avatarMissing = '507f1f77bcf86cd799439012';
    const coverDetached = '507f1f77bcf86cd799439013';
    const avatarWrongPrefix = '507f1f77bcf86cd799439014';
    const malformedImageId = 'not-an-object-id';
    const assets = [
        {
            _id: coverAttached,
            ownerType: 'album',
            ownerId: 'album-one',
            s3Key: `images/${coverAttached}`,
            uploadStatus: 'ready'
        },
        {
            _id: avatarMissing,
            ownerType: 'user',
            ownerId: 'user-one',
            s3Key: `avatars/${avatarMissing}`,
            uploadStatus: 'deleteFailed',
            uploadError: 'previous cleanup failed'
        },
        {
            _id: coverDetached,
            ownerType: 'artist',
            ownerId: 'missing-artist',
            s3Key: `images/${coverDetached}`,
            uploadStatus: 'ready'
        },
        {
            _id: avatarWrongPrefix,
            ownerType: 'user',
            ownerId: 'user-two',
            s3Key: `images/${avatarWrongPrefix}`,
            uploadStatus: 'ready'
        },
        {
            _id: malformedImageId,
            ownerType: 'album',
            ownerId: 'album-malformed',
            s3Key: `images/${malformedImageId}`,
            uploadStatus: 'ready'
        }
    ];
    const owners: Record<string, any[]> = {
        artist: [{ _id: 'artist-with-missing-asset', coverArtId: 'missing-cover' }],
        album: [
            { _id: 'album-one', coverArtId: coverAttached },
            { _id: 'album-malformed', coverArtId: malformedImageId }
        ],
        audioTrack: [],
        user: [
            { _id: 'user-one', avatarAssetId: avatarMissing },
            { _id: 'user-two', avatarAssetId: avatarWrongPrefix }
        ]
    };
    const storageLists = {
        'images/': [
            { key: `images/${coverAttached}`, size: 10 },
            { key: `images/${coverDetached}`, size: 11 },
            { key: `images/${avatarWrongPrefix}`, size: 12 },
            { key: 'images/orphan-cover', size: 13 },
            { key: `images/${malformedImageId}`, size: 15 }
        ],
        'avatars/': [{ key: 'avatars/orphan-avatar', size: 14 }]
    } as const;
    let mutations = 0;

    const report = await reconcileImageStorage({
        bucket: 'audit-bucket',
        loadAssets: async () => assets,
        loadOwners: async ownerType => owners[ownerType],
        listObjects: async (_bucket, prefix) => [...storageLists[prefix]],
        headObject: async (_bucket, key) => ({
            Metadata: {
                imageid: key.split('/').at(-1),
                ownertype: key.startsWith('avatars/') ? 'user' : 'album'
            }
        })
    });

    assert.equal(mutations, 0);
    assert.equal(report.summary.databaseCoverArtCount, 3);
    assert.equal(report.summary.databaseAvatarCount, 2);
    assert.equal(report.summary.s3CoverArtCount, 5);
    assert.equal(report.summary.s3AvatarCount, 1);
    assert.equal(report.summary.orphanedObjectCount, 2);
    assert.deepEqual(
        report.orphanedObjects.map(object => object.key).sort(),
        ['avatars/orphan-avatar', 'images/orphan-cover']
    );
    assert.deepEqual(report.missingObjects.map(asset => asset.imageId), [avatarMissing]);
    assert.deepEqual(report.incompleteAssets.map(asset => asset.imageId), [avatarMissing]);
    assert.deepEqual(report.detachedAssets.map(asset => asset.imageId), [coverDetached]);
    assert.deepEqual(
        report.invalidStorageKeys.map(asset => asset.imageId),
        [avatarWrongPrefix, malformedImageId]
    );
    assert.deepEqual(report.danglingOwnerReferences, [{
        ownerType: 'artist',
        ownerId: 'artist-with-missing-asset',
        referenceField: 'coverArtId',
        imageId: 'missing-cover',
        reason: 'missingAsset'
    }]);
});
