import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { ObjectId } from 'mongodb';

import { getDb } from '../src/infrastructure/database';
import { Album } from '../src/models/album';
import { Artist } from '../src/models/artist';
import { AudioTrack } from '../src/models/audioTrack';
import { Carousel } from '../src/models/carousel';
import { ContentCollection } from '../src/models/contentCollection';
import { UserLibrary } from '../src/models/userLibrary';
import { SimpleDate } from '../src/models/simpleDate';
import {
    AlbumDeletionOutcomeUnknownError,
    deleteAlbumAndReferences
} from '../src/services/albumLifecycleService';
import { withReadyAlbumReferences } from '../src/services/albumReferenceFenceService';
import { cleanupDeletedContentReferences } from '../src/services/contentReferenceService';
import {
    getPublicAlbum,
    listPublicAlbums,
    listPublicAudioTracks,
    searchPublicCatalog
} from '../src/services/publicCatalogService';
import {
    getListenerAlbum,
    searchListenerContent
} from '../src/services/listenerContentService';
import {
    clearReadyAudioTrackAlbumLinks,
    linkReadyAudioTracksToAlbum,
    publishUploadedAudioTracks
} from '../src/services/albumTrackLinkService';
import { retryAudioTrackPublications } from '../src/services/audioPublicationRecoveryService';
import { postAudioPublicationRetry } from '../src/controllers/adminController';
import { updateAlbum } from '../src/controllers/albumController';
import { updateAlbumWeb } from '../src/controllers/contentController';
import {
    finalizeStagedCoverArtLifecycleRecord,
    prepareOwnerCoverArtDeletions,
    stageCoverArtLifecycleRecord
} from '../src/services/imageStorageService';
import {
    MongoReplicaSetHarness,
    startMongoReplicaSet
} from './support/mongoReplicaSet';

let harness: MongoReplicaSetHarness | undefined;

const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise; });
    return { promise, resolve };
};

before(async () => {
    harness = await startMongoReplicaSet('archtree-album-lifecycle-test');
});

beforeEach(async () => {
    await Promise.all([
        'albums',
        'artists',
        'audioTracks',
        'carousels',
        'contentCollections',
        'imageAssets',
        'userSaves',
        'userActivity',
        'users'
    ].map((collection) => getDb()!.collection(collection).deleteMany({})));
});

after(async () => {
    await harness?.stop();
});

test('a committed Album reference is observed and removed by concurrent deletion', async () => {
    const albumId = new ObjectId();
    const artistId = new ObjectId();
    await getDb()!.collection('albums').insertOne({
        _id: albumId,
        title: 'Reference first',
        lifecycleStatus: 'ready',
        referenceRevision: 0
    });

    const referenceWritten = deferred();
    const releaseReference = deferred();
    const reference = withReadyAlbumReferences(
        [albumId.toHexString()],
        async (session, albumIds) => {
            await getDb()!.collection('artists').insertOne({
                _id: artistId,
                name: 'Concurrent Album Artist',
                albumIds
            }, { session });
            referenceWritten.resolve();
            await releaseReference.promise;
        }
    );
    await referenceWritten.promise;

    const deletion = deleteAlbumAndReferences(albumId.toHexString());
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseReference.resolve();

    await reference;
    assert.equal((await deletion).ownerDeleted, true);
    assert.deepEqual(
        (await getDb()!.collection('artists').findOne({ _id: artistId }))!.albumIds,
        []
    );
});

test('a deleting Album rejects supported new-reference writes and owner mutation', async () => {
    const albumId = new ObjectId();
    const artistId = new ObjectId();
    const trackId = new ObjectId();
    const carouselId = new ObjectId();
    const collectionId = new ObjectId();
    const userId = new ObjectId();
    await Promise.all([
        getDb()!.collection('albums').insertOne({
            _id: albumId,
            title: 'Deletion first',
            lifecycleStatus: 'ready',
            referenceRevision: 0
        }),
        getDb()!.collection('artists').insertOne({
            _id: artistId,
            name: 'Existing Artist',
            albumIds: [],
            lifecycleStatus: 'ready',
            referenceRevision: 0
        }),
        getDb()!.collection('audioTracks').insertOne({
            _id: trackId,
            title: 'Existing Track',
            artistIds: [],
            albumId: '',
            uploadStatus: 'ready',
            s3Key: trackId.toHexString()
        }),
        getDb()!.collection('carousels').insertOne({
            _id: carouselId,
            name: 'Existing Carousel',
            mode: 'manual',
            items: []
        }),
        getDb()!.collection('contentCollections').insertOne({
            _id: collectionId,
            name: 'Existing Grid',
            mode: 'manual',
            contentType: 'album',
            items: []
        }),
        getDb()!.collection('users').insertOne({ _id: userId })
    ]);

    const transitioned = deferred();
    const releaseCleanup = deferred();
    const deletion = deleteAlbumAndReferences(albumId.toHexString(), {
        cleanupReferences: async (type, contentId) => {
            transitioned.resolve();
            await releaseCleanup.promise;
            await cleanupDeletedContentReferences(type, contentId);
        }
    });
    await transitioned.promise;

    const writes = await Promise.allSettled([
        Artist.updateById(artistId.toHexString(), { albumIds: [albumId.toHexString()] }),
        linkReadyAudioTracksToAlbum(albumId.toHexString(), [trackId.toHexString()]),
        Carousel.updateById(carouselId.toHexString(), {
            items: [{ contentType: 'album', contentId: albumId.toHexString(), order: 0 }]
        }),
        ContentCollection.addItem(collectionId.toHexString(), {
            contentType: 'album',
            contentId: albumId.toHexString()
        }, userId.toHexString()),
        UserLibrary.save(userId.toHexString(), 'album', albumId.toHexString()),
        Album.updateById(albumId.toHexString(), { title: 'Too late' })
    ]);
    assert.equal(writes.every((result) => result.status === 'rejected'), true);
    const coverUpdate = await Album.updateCoverArtById(
        albumId.toHexString(),
        null,
        { coverArtId: new ObjectId().toHexString() }
    );
    assert.equal(coverUpdate.matchedCount, 0);

    releaseCleanup.resolve();
    assert.equal((await deletion).ownerDeleted, true);
    assert.deepEqual(
        (await getDb()!.collection('artists').findOne({ _id: artistId }))!.albumIds,
        []
    );
    assert.equal(
        (await getDb()!.collection('audioTracks').findOne({ _id: trackId }))!.albumId,
        ''
    );
    assert.deepEqual(
        (await getDb()!.collection('carousels').findOne({ _id: carouselId }))!.items,
        []
    );
    assert.deepEqual(
        (await getDb()!.collection('contentCollections').findOne({ _id: collectionId }))!.items,
        []
    );
    assert.equal(await getDb()!.collection('userSaves').countDocuments({}), 0);
});

test('failed Album reference cleanup retains evidence and a retry completes deletion', async () => {
    const albumId = new ObjectId();
    await getDb()!.collection('albums').insertOne({
        _id: albumId,
        title: 'Retry Album',
        lifecycleStatus: 'ready',
        referenceRevision: 0
    });

    const failed = await deleteAlbumAndReferences(albumId.toHexString(), {
        cleanupReferences: async () => { throw new Error('simulated cleanup failure'); }
    });
    assert.equal(failed.ownerDeleted, false);
    assert.equal(failed.cleanupPending, true);
    const retained = await getDb()!.collection('albums').findOne({ _id: albumId });
    assert.equal(retained!.lifecycleStatus, 'deleteFailed');
    assert.match(retained!.lifecycleError, /simulated cleanup failure/);

    const retried = await deleteAlbumAndReferences(albumId.toHexString());
    assert.equal(retried.ownerDeleted, true);
    assert.equal(await getDb()!.collection('albums').findOne({ _id: albumId }), null);
});

test('Album deletion includes detached artwork before removing its owner', async () => {
    const albumId = new ObjectId();
    const currentImageId = new ObjectId().toHexString();
    const detachedImageId = new ObjectId().toHexString();
    await getDb()!.collection('albums').insertOne({
        _id: albumId,
        title: 'Detached artwork Album',
        coverArtId: currentImageId,
        lifecycleStatus: 'ready',
        referenceRevision: 0
    });

    const failed = await deleteAlbumAndReferences(albumId.toHexString(), {
        prepareOwnerCoverArt: async () => {
            throw new Error('detached object deletion failed');
        }
    });
    assert.equal(failed.ownerDeleted, false);
    assert.equal(failed.cleanupPending, true);
    assert.ok(await getDb()!.collection('albums').findOne({ _id: albumId }));

    let finalized: readonly string[] = [];
    const retried = await deleteAlbumAndReferences(albumId.toHexString(), {
        prepareOwnerCoverArt: async (_ownerId, observedCurrentId) => {
            assert.equal(observedCurrentId, currentImageId);
            return [currentImageId, detachedImageId];
        },
        finalizeOwnerCoverArt: async (imageIds) => { finalized = imageIds; }
    });
    assert.equal(retried.ownerDeleted, true);
    assert.equal(retried.cleanupPending, false);
    assert.deepEqual(finalized, [currentImageId, detachedImageId]);
});

test('a deleting Album rejects later cover-art lifecycle staging', async () => {
    const albumId = new ObjectId();
    const imageId = new ObjectId();
    await getDb()!.collection('albums').insertOne({
        _id: albumId,
        title: 'Artwork fence Album',
        lifecycleStatus: 'ready',
        referenceRevision: 0
    });
    const deletionStarted = deferred();
    const releaseDeletion = deferred();
    const deletion = deleteAlbumAndReferences(albumId.toHexString(), {
        prepareOwnerCoverArt: async () => {
            deletionStarted.resolve();
            await releaseDeletion.promise;
            return [];
        }
    });
    await deletionStarted.promise;

    await assert.rejects(
        stageCoverArtLifecycleRecord({
            _id: imageId,
            ownerType: 'album',
            ownerId: albumId.toHexString(),
            createdBy: new ObjectId().toHexString(),
            originalFileName: 'late.jpg',
            contentType: 'image/jpeg',
            s3Key: `images/${imageId.toHexString()}`,
            uploadStatus: 'pending',
            uploadUpdatedAt: new Date(),
            uploadError: null
        }),
        (error: any) => error?.code === 'album_reference_unavailable'
    );
    assert.equal(await getDb()!.collection('imageAssets').countDocuments({}), 0);

    releaseDeletion.resolve();
    assert.equal((await deletion).ownerDeleted, true);
});

test('cover upload finalization commits before Album deletion enumerates the ready asset', async () => {
    const albumId = new ObjectId();
    const imageId = new ObjectId();
    const createdBy = new ObjectId().toHexString();
    await Promise.all([
        getDb()!.collection('users').insertOne({
            _id: ObjectId.createFromHexString(createdBy),
            email: 'upload-wins@example.com'
        }),
        getDb()!.collection('albums').insertOne({
            _id: albumId,
            title: 'Upload wins Album',
            coverArtId: imageId.toHexString(),
            lifecycleStatus: 'ready',
            referenceRevision: 0
        })
    ]);
    const staged = {
        _id: imageId,
        ownerType: 'album' as const,
        ownerId: albumId.toHexString(),
        createdBy,
        originalFileName: 'cover.jpg',
        contentType: 'image/jpeg',
        s3Key: `images/${imageId.toHexString()}`,
        uploadStatus: 'pending' as const,
        uploadUpdatedAt: new Date(),
        uploadError: null
    };
    await stageCoverArtLifecycleRecord(staged);
    await finalizeStagedCoverArtLifecycleRecord(staged);

    const deletedKeys: string[] = [];
    const deleted = await deleteAlbumAndReferences(albumId.toHexString(), {
        prepareOwnerCoverArt: (ownerId, currentImageId) => prepareOwnerCoverArtDeletions(
            'album',
            ownerId,
            currentImageId,
            { deleteObject: async key => { deletedKeys.push(key); } }
        )
    });
    assert.equal(deleted.ownerDeleted, true);
    assert.deepEqual(deletedKeys, [staged.s3Key]);
    assert.equal(await getDb()!.collection('imageAssets').findOne({ _id: imageId }), null);
});

test('Album deletion first retains pending cover evidence until upload cleanup is recoverable', async () => {
    const albumId = new ObjectId();
    const imageId = new ObjectId();
    const createdBy = new ObjectId().toHexString();
    await Promise.all([
        getDb()!.collection('users').insertOne({
            _id: ObjectId.createFromHexString(createdBy),
            email: 'deletion-wins@example.com'
        }),
        getDb()!.collection('albums').insertOne({
            _id: albumId,
            title: 'Deletion wins Album',
            coverArtId: imageId.toHexString(),
            lifecycleStatus: 'ready',
            referenceRevision: 0
        })
    ]);
    const staged = {
        _id: imageId,
        ownerType: 'album' as const,
        ownerId: albumId.toHexString(),
        createdBy,
        originalFileName: 'cover.jpg',
        contentType: 'image/jpeg',
        s3Key: `images/${imageId.toHexString()}`,
        uploadStatus: 'pending' as const,
        uploadUpdatedAt: new Date(),
        uploadError: null
    };
    await stageCoverArtLifecycleRecord(staged);

    let storageDeletes = 0;
    const prepare = (ownerId: string, currentImageId: string | null | undefined) =>
        prepareOwnerCoverArtDeletions('album', ownerId, currentImageId, {
            deleteObject: async () => { storageDeletes += 1; }
        });
    const firstDelete = await deleteAlbumAndReferences(albumId.toHexString(), {
        prepareOwnerCoverArt: prepare
    });
    assert.equal(firstDelete.ownerDeleted, false);
    assert.equal(firstDelete.cleanupPending, true);
    assert.equal(storageDeletes, 0);
    assert.equal(
        (await getDb()!.collection('imageAssets').findOne({ _id: imageId }))!.uploadStatus,
        'pending'
    );

    await assert.rejects(
        finalizeStagedCoverArtLifecycleRecord(staged),
        (error: any) => error?.code === 'album_reference_unavailable'
    );
    await getDb()!.collection('imageAssets').updateOne(
        { _id: imageId, uploadStatus: 'pending' },
        { $set: { uploadStatus: 'failed', uploadError: 'owner deletion won' } }
    );

    const retried = await deleteAlbumAndReferences(albumId.toHexString(), {
        prepareOwnerCoverArt: prepare
    });
    assert.equal(retried.ownerDeleted, true);
    assert.equal(storageDeletes, 1);
    assert.equal(await getDb()!.collection('imageAssets').findOne({ _id: imageId }), null);
});

test('Album deletion finalizes cover evidence after a committed delete response is lost', async () => {
    const albumId = new ObjectId();
    const coverArtId = new ObjectId().toHexString();
    await getDb()!.collection('albums').insertOne({
        _id: albumId,
        title: 'Lost response Album',
        coverArtId,
        lifecycleStatus: 'ready',
        referenceRevision: 0
    });
    let finalized = 0;

    const result = await deleteAlbumAndReferences(albumId.toHexString(), {
        prepareCoverArt: async () => true,
        cleanupReferences: async () => undefined,
        deleteOwner: async (id, referenceRevision) => {
            await getDb()!.collection('albums').deleteOne({
                _id: ObjectId.createFromHexString(id),
                lifecycleStatus: 'deleting',
                referenceRevision
            });
            throw new Error('database response lost');
        },
        finalizeCoverArt: async () => { finalized += 1; }
    });

    assert.equal(result.ownerDeleted, true);
    assert.equal(result.cleanupPending, false);
    assert.equal(finalized, 1);
});

test('Album deletion reports an unknown outcome when confirmation is unavailable', async () => {
    const albumId = new ObjectId();
    await getDb()!.collection('albums').insertOne({
        _id: albumId,
        title: 'Unknown outcome Album',
        lifecycleStatus: 'ready',
        referenceRevision: 0
    });
    await assert.rejects(
        deleteAlbumAndReferences(albumId.toHexString(), {
            cleanupReferences: async () => undefined,
            deleteOwner: async () => { throw new Error('database response lost'); },
            findOwner: async () => { throw new Error('confirmation unavailable'); }
        }),
        (error: any) => error instanceof AlbumDeletionOutcomeUnknownError
            && error.cleanupPending === true
    );
});

test('legacy and ready Albums remain public while non-ready Albums disappear', async () => {
    const legacyId = new ObjectId();
    const readyId = new ObjectId();
    const deletingId = new ObjectId();
    const deleteFailedId = new ObjectId();
    const trackId = new ObjectId();
    await Promise.all([
        getDb()!.collection('albums').insertMany([
            { _id: legacyId, title: 'Lifecycle Legacy Album', audioTrackIds: [] },
            {
                _id: readyId,
                title: 'Lifecycle Ready Album',
                audioTrackIds: [],
                lifecycleStatus: 'ready',
                referenceRevision: 0
            },
            {
                _id: deletingId,
                title: 'Lifecycle Deleting Album',
                audioTrackIds: [],
                lifecycleStatus: 'deleting',
                referenceRevision: 1
            },
            {
                _id: deleteFailedId,
                title: 'Lifecycle Failed Album',
                audioTrackIds: [],
                lifecycleStatus: 'deleteFailed',
                referenceRevision: 2
            }
        ]),
        getDb()!.collection('audioTracks').insertOne({
            _id: trackId,
            title: 'Lifecycle Album Track',
            albumId: deletingId.toHexString(),
            artistIds: [],
            uploadStatus: 'ready',
            s3Key: trackId.toHexString()
        })
    ]);

    const visibleIds = new Set((await listPublicAlbums(20, 0)).map((album) => album._id));
    assert.deepEqual(visibleIds, new Set([legacyId.toHexString(), readyId.toHexString()]));
    assert.equal(await getPublicAlbum(deletingId.toHexString()), null);
    assert.equal(await getListenerAlbum(deleteFailedId.toHexString()), null);
    const publicSearch = await searchPublicCatalog('Lifecycle', 20);
    const listenerSearch = await searchListenerContent('Lifecycle', 20);
    assert.deepEqual(
        new Set(publicSearch.albums.map((album) => album._id)),
        new Set([legacyId.toHexString(), readyId.toHexString()])
    );
    assert.deepEqual(
        new Set(listenerSearch.albums.map((album) => album.id)),
        new Set([legacyId.toHexString(), readyId.toHexString()])
    );
    const [publicTrack] = await listPublicAudioTracks(20, 0);
    assert.equal(publicTrack.albumId, null);
});

test('only a pre-lifecycle empty Album receives public and listener reverse-link fallback', async () => {
    const legacyAlbumId = new ObjectId();
    const lifecycleAlbumId = new ObjectId();
    const legacyTrackId = new ObjectId();
    const lifecycleTrackId = new ObjectId();
    await Promise.all([
        getDb()!.collection('albums').insertMany([
            { _id: legacyAlbumId, title: 'True Legacy Album', audioTrackIds: [] },
            {
                _id: lifecycleAlbumId,
                title: 'Lifecycle Empty Album',
                audioTrackIds: [],
                lifecycleStatus: 'ready',
                referenceRevision: 0
            }
        ]),
        getDb()!.collection('audioTracks').insertMany([
            {
                _id: legacyTrackId,
                title: 'Legacy Reverse Track',
                albumId: legacyAlbumId.toHexString().toUpperCase(),
                uploadStatus: 'ready',
                s3Key: legacyTrackId.toHexString(),
                publicationStatus: 'ready'
            },
            {
                _id: lifecycleTrackId,
                title: 'Lifecycle Reverse Track',
                albumId: lifecycleAlbumId.toHexString().toUpperCase(),
                uploadStatus: 'ready',
                s3Key: lifecycleTrackId.toHexString(),
                publicationStatus: 'ready'
            }
        ])
    ]);

    assert.deepEqual(
        (await getPublicAlbum(legacyAlbumId.toHexString().toUpperCase()))!.audioTrackIds,
        [legacyTrackId.toHexString()]
    );
    assert.deepEqual(
        (await getPublicAlbum(lifecycleAlbumId.toHexString()))!.audioTrackIds,
        []
    );
    assert.deepEqual(
        (await getListenerAlbum(legacyAlbumId.toHexString().toUpperCase()))!.tracks.map((track) => track.id),
        [legacyTrackId.toHexString()]
    );
    assert.deepEqual(
        (await getListenerAlbum(lifecycleAlbumId.toHexString()))!.tracks,
        []
    );
});

test('public and listener Album projections canonicalize mixed uppercase declared IDs', async () => {
    const albumId = new ObjectId();
    const trackId = new ObjectId();
    await Promise.all([
        getDb()!.collection('albums').insertOne({
            _id: albumId,
            title: 'Mixed Representation Album',
            audioTrackIds: [trackId.toHexString().toUpperCase(), trackId],
            lifecycleStatus: 'ready',
            referenceRevision: 0
        }),
        getDb()!.collection('audioTracks').insertOne({
            _id: trackId,
            title: 'Mixed Representation Track',
            albumId: albumId.toHexString().toUpperCase(),
            artistIds: [],
            uploadStatus: 'ready',
            s3Key: trackId.toHexString(),
            publicationStatus: 'ready'
        })
    ]);

    assert.deepEqual(
        (await getPublicAlbum(albumId.toHexString().toUpperCase()))!.audioTrackIds,
        [trackId.toHexString()]
    );
    const listener = await getListenerAlbum(albumId.toHexString().toUpperCase());
    assert.deepEqual(listener!.tracks.map((track) => ({
        id: track.id,
        albumId: track.albumId
    })), [{ id: trackId.toHexString(), albumId: albumId.toHexString() }]);
});

test('Album/Soundtrack linking is atomic when either reference is unavailable', async () => {
    const albumId = new ObjectId();
    const readyTrackId = new ObjectId();
    const missingTrackId = new ObjectId();
    await Promise.all([
        getDb()!.collection('albums').insertOne({
            _id: albumId,
            title: 'Atomic Link Album',
            audioTrackIds: [],
            lifecycleStatus: 'ready',
            referenceRevision: 0
        }),
        getDb()!.collection('audioTracks').insertOne({
            _id: readyTrackId,
            title: 'Atomic Link Track',
            albumId: '',
            uploadStatus: 'ready',
            s3Key: readyTrackId.toHexString()
        })
    ]);

    await assert.rejects(
        linkReadyAudioTracksToAlbum(albumId.toHexString(), [missingTrackId.toHexString()]),
        (error: any) => error?.code === 'audio_track_reference_unavailable'
    );
    const afterFailure = await getDb()!.collection('albums').findOne({ _id: albumId });
    assert.equal(afterFailure!.referenceRevision, 0);
    assert.deepEqual(afterFailure!.audioTrackIds, []);

    await linkReadyAudioTracksToAlbum(albumId.toHexString(), [readyTrackId.toHexString()]);
    assert.deepEqual(
        (await getDb()!.collection('albums').findOne({ _id: albumId }))!.audioTrackIds,
        [readyTrackId.toHexString()]
    );
    assert.equal(
        (await getDb()!.collection('audioTracks').findOne({ _id: readyTrackId }))!.albumId,
        albumId.toHexString()
    );
});

test('Soundtrack relink and clear replace every prior canonical Album membership atomically', async () => {
    const oldAlbumId = new ObjectId();
    const staleAlbumId = new ObjectId();
    const newAlbumId = new ObjectId();
    const trackId = new ObjectId();
    await Promise.all([
        getDb()!.collection('albums').insertMany([
            {
                _id: oldAlbumId,
                title: 'Old Album',
                audioTrackIds: [trackId.toHexString().toUpperCase()],
                lifecycleStatus: 'ready',
                referenceRevision: 0
            },
            {
                _id: staleAlbumId,
                title: 'Stale Album',
                audioTrackIds: [trackId],
                lifecycleStatus: 'ready',
                referenceRevision: 0
            },
            {
                _id: newAlbumId,
                title: 'New Album',
                audioTrackIds: [trackId, trackId.toHexString()],
                lifecycleStatus: 'ready',
                referenceRevision: 0
            }
        ]),
        getDb()!.collection('audioTracks').insertOne({
            _id: trackId,
            title: 'Relink Track',
            albumId: oldAlbumId.toHexString().toUpperCase(),
            uploadStatus: 'ready',
            s3Key: trackId.toHexString(),
            publicationStatus: 'ready'
        })
    ]);

    await linkReadyAudioTracksToAlbum(newAlbumId.toHexString(), [trackId.toHexString()]);
    assert.deepEqual(
        (await getDb()!.collection('albums').findOne({ _id: oldAlbumId }))!.audioTrackIds,
        []
    );
    assert.deepEqual(
        (await getDb()!.collection('albums').findOne({ _id: staleAlbumId }))!.audioTrackIds,
        []
    );
    assert.deepEqual(
        (await getDb()!.collection('albums').findOne({ _id: newAlbumId }))!.audioTrackIds,
        [trackId.toHexString()]
    );
    assert.equal(
        (await getDb()!.collection('audioTracks').findOne({ _id: trackId }))!.albumId,
        newAlbumId.toHexString()
    );

    await getDb()!.collection('audioTracks').updateOne(
        { _id: trackId },
        { $set: { albumId: newAlbumId.toHexString().toUpperCase() } }
    );
    await clearReadyAudioTrackAlbumLinks([trackId.toHexString()]);
    assert.deepEqual(
        (await getDb()!.collection('albums').findOne({ _id: newAlbumId }))!.audioTrackIds,
        []
    );
    assert.equal(
        (await getDb()!.collection('audioTracks').findOne({ _id: trackId }))!.albumId,
        ''
    );
    await assert.rejects(
        Promise.resolve().then(() => AudioTrack.updateById(trackId.toHexString(), {
            albumId: oldAlbumId.toHexString()
        })),
        (error: any) => error?.code === 'audio_track_album_relink_required'
    );
});

test('Album update replaces ordered membership and both Track directions in one transaction', async () => {
    const albumId = new ObjectId();
    const otherAlbumId = new ObjectId();
    const retainedTrackId = new ObjectId();
    const removedTrackId = new ObjectId();
    const addedTrackId = new ObjectId();
    await Promise.all([
        getDb()!.collection('albums').insertMany([
            {
                _id: albumId,
                title: 'Before Replace',
                audioTrackIds: [
                    retainedTrackId,
                    retainedTrackId.toHexString(),
                    removedTrackId.toHexString()
                ],
                lifecycleStatus: 'ready',
                referenceRevision: 0
            },
            {
                _id: otherAlbumId,
                title: 'Other Album',
                audioTrackIds: [addedTrackId, addedTrackId.toHexString()],
                lifecycleStatus: 'ready',
                referenceRevision: 0
            }
        ]),
        getDb()!.collection('audioTracks').insertMany([
            {
                _id: retainedTrackId,
                albumId: albumId.toHexString(),
                uploadStatus: 'ready',
                s3Key: retainedTrackId.toHexString()
            },
            {
                _id: removedTrackId,
                albumId: albumId.toHexString(),
                uploadStatus: 'ready',
                s3Key: removedTrackId.toHexString()
            },
            {
                _id: addedTrackId,
                albumId: otherAlbumId.toHexString(),
                uploadStatus: 'ready',
                s3Key: addedTrackId.toHexString()
            }
        ])
    ]);

    await Album.updateById(albumId.toHexString(), {
        title: 'After Replace',
        audioTrackIds: [
            addedTrackId.toHexString(),
            retainedTrackId.toHexString(),
            addedTrackId.toHexString()
        ]
    });

    const [album, otherAlbum, retainedTrack, removedTrack, addedTrack] = await Promise.all([
        getDb()!.collection('albums').findOne({ _id: albumId }),
        getDb()!.collection('albums').findOne({ _id: otherAlbumId }),
        getDb()!.collection('audioTracks').findOne({ _id: retainedTrackId }),
        getDb()!.collection('audioTracks').findOne({ _id: removedTrackId }),
        getDb()!.collection('audioTracks').findOne({ _id: addedTrackId })
    ]);
    assert.equal(album!.title, 'After Replace');
    assert.deepEqual(album!.audioTrackIds, [
        addedTrackId.toHexString(),
        retainedTrackId.toHexString()
    ]);
    assert.deepEqual(otherAlbum!.audioTrackIds, []);
    assert.equal(retainedTrack!.albumId, albumId.toHexString());
    assert.equal(removedTrack!.albumId, '');
    assert.equal(addedTrack!.albumId, albumId.toHexString());
});

test('Album replacement removes dangling and non-ready members without weakening desired readiness', async () => {
    const albumId = new ObjectId();
    const retainedTrackId = new ObjectId();
    const pendingTrackId = new ObjectId();
    const danglingTrackId = new ObjectId();
    const strayReverseTrackId = new ObjectId();
    await Promise.all([
        getDb()!.collection('albums').insertOne({
            _id: albumId,
            title: 'Repairable Album',
            audioTrackIds: [
                retainedTrackId.toHexString(),
                pendingTrackId.toHexString(),
                danglingTrackId.toHexString()
            ],
            lifecycleStatus: 'ready',
            referenceRevision: 0
        }),
        getDb()!.collection('audioTracks').insertMany([
            {
                _id: retainedTrackId,
                albumId: albumId.toHexString(),
                uploadStatus: 'ready',
                s3Key: retainedTrackId.toHexString(),
                publicationStatus: 'ready'
            },
            {
                _id: pendingTrackId,
                albumId: albumId.toHexString().toUpperCase(),
                uploadStatus: 'ready',
                s3Key: pendingTrackId.toHexString(),
                publicationStatus: 'pending'
            },
            {
                _id: strayReverseTrackId,
                albumId: albumId.toHexString().toUpperCase(),
                uploadStatus: 'pending',
                s3Key: strayReverseTrackId.toHexString()
            }
        ])
    ]);

    await Album.updateById(albumId.toHexString(), {
        title: 'Repaired Album',
        audioTrackIds: [retainedTrackId.toHexString().toUpperCase()]
    });

    assert.deepEqual(
        (await getDb()!.collection('albums').findOne({ _id: albumId }))!.audioTrackIds,
        [retainedTrackId.toHexString()]
    );
    assert.equal(
        (await getDb()!.collection('audioTracks').findOne({ _id: retainedTrackId }))!.albumId,
        albumId.toHexString()
    );
    assert.equal(
        (await getDb()!.collection('audioTracks').findOne({ _id: pendingTrackId }))!.albumId,
        ''
    );
    assert.equal(
        (await getDb()!.collection('audioTracks').findOne({ _id: strayReverseTrackId }))!.albumId,
        ''
    );
});

test('combined Album cover CAS and ordered Track replacement commit or reject as one unit', async () => {
    const albumId = new ObjectId();
    const retainedTrackId = new ObjectId();
    const addedTrackId = new ObjectId();
    const pendingTrackId = new ObjectId();
    const oldCoverArtId = new ObjectId().toHexString();
    const newCoverArtId = new ObjectId().toHexString();
    await Promise.all([
        getDb()!.collection('albums').insertOne({
            _id: albumId,
            title: 'Before Atomic Cover',
            coverArtId: oldCoverArtId,
            coverArtUrl: `/content/images/${oldCoverArtId}`,
            audioTrackIds: [retainedTrackId.toHexString()],
            lifecycleStatus: 'ready',
            referenceRevision: 0
        }),
        getDb()!.collection('audioTracks').insertMany([
            {
                _id: retainedTrackId,
                albumId: albumId.toHexString(),
                uploadStatus: 'ready',
                s3Key: retainedTrackId.toHexString(),
                publicationStatus: 'ready'
            },
            {
                _id: addedTrackId,
                albumId: '',
                uploadStatus: 'ready',
                s3Key: addedTrackId.toHexString(),
                publicationStatus: 'ready'
            },
            {
                _id: pendingTrackId,
                albumId: '',
                uploadStatus: 'ready',
                s3Key: pendingTrackId.toHexString(),
                publicationStatus: 'pending'
            }
        ])
    ]);

    await assert.rejects(
        Album.updateCoverArtById(albumId.toHexString(), oldCoverArtId, {
            title: 'Must Roll Back',
            coverArtId: newCoverArtId,
            coverArtUrl: `/content/images/${newCoverArtId}`,
            audioTrackIds: [pendingTrackId.toHexString()]
        })
    );
    let album = await getDb()!.collection('albums').findOne({ _id: albumId });
    assert.equal(album!.title, 'Before Atomic Cover');
    assert.equal(album!.coverArtId, oldCoverArtId);
    assert.deepEqual(album!.audioTrackIds, [retainedTrackId.toHexString()]);
    assert.equal(
        (await getDb()!.collection('audioTracks').findOne({ _id: retainedTrackId }))!.albumId,
        albumId.toHexString()
    );
    assert.equal(
        (await getDb()!.collection('audioTracks').findOne({ _id: pendingTrackId }))!.albumId,
        ''
    );

    await assert.rejects(
        Promise.resolve().then(() => Album.updateCoverArtById(
            albumId.toHexString(),
            oldCoverArtId,
            { audioTrackIds: ['not-an-object-id'], coverArtId: newCoverArtId }
        )),
        /invalid/i
    );
    album = await getDb()!.collection('albums').findOne({ _id: albumId });
    assert.equal(album!.coverArtId, oldCoverArtId);

    await Album.updateCoverArtById(albumId.toHexString(), oldCoverArtId, {
        title: 'After Atomic Cover',
        coverArtId: newCoverArtId,
        coverArtUrl: `/content/images/${newCoverArtId}`,
        audioTrackIds: [addedTrackId.toHexString(), retainedTrackId.toHexString()]
    });
    album = await getDb()!.collection('albums').findOne({ _id: albumId });
    assert.equal(album!.title, 'After Atomic Cover');
    assert.equal(album!.coverArtId, newCoverArtId);
    assert.deepEqual(album!.audioTrackIds, [
        addedTrackId.toHexString(),
        retainedTrackId.toHexString()
    ]);
    assert.equal(
        (await getDb()!.collection('audioTracks').findOne({ _id: addedTrackId }))!.albumId,
        albumId.toHexString()
    );
});

test('JSON rejects combined cover/list failures and Web commits combined ready order through the atomic path', async () => {
    const apiAlbumId = new ObjectId();
    const apiReadyTrackId = new ObjectId();
    const apiPendingTrackId = new ObjectId();
    const previousCoverArtId = new ObjectId().toHexString();
    await Promise.all([
        getDb()!.collection('albums').insertOne({
            _id: apiAlbumId,
            title: 'API Before',
            coverArtId: previousCoverArtId,
            coverArtUrl: `/content/images/${previousCoverArtId}`,
            audioTrackIds: [apiReadyTrackId.toHexString()],
            lifecycleStatus: 'ready',
            referenceRevision: 0
        }),
        getDb()!.collection('imageAssets').insertOne({
            _id: ObjectId.createFromHexString(previousCoverArtId),
            ownerType: 'album',
            ownerId: apiAlbumId.toHexString(),
            s3Key: `images/${previousCoverArtId}`,
            uploadStatus: 'ready'
        }),
        getDb()!.collection('audioTracks').insertMany([
            {
                _id: apiReadyTrackId,
                albumId: apiAlbumId.toHexString(),
                uploadStatus: 'ready',
                s3Key: apiReadyTrackId.toHexString(),
                publicationStatus: 'ready'
            },
            {
                _id: apiPendingTrackId,
                albumId: '',
                uploadStatus: 'ready',
                s3Key: apiPendingTrackId.toHexString(),
                publicationStatus: 'pending'
            }
        ])
    ]);

    const apiResponseCapture: { status?: number; body?: any } = {};
    const apiResponse = {
        status(status: number) {
            apiResponseCapture.status = status;
            return this;
        },
        json(body: any) {
            apiResponseCapture.body = body;
            return this;
        }
    };
    const apiRequest = (audioTrackIds: string[]) => ({
        auth: { userId: new ObjectId().toHexString(), role: 'admin' },
        params: { albumId: apiAlbumId.toHexString() },
        body: {
            title: 'API Must Roll Back',
            removeCoverArt: 'true',
            audioTrackIds
        }
    });
    await updateAlbum(
        apiRequest([apiPendingTrackId.toHexString()]) as any,
        apiResponse as any,
        (error) => { throw error; }
    );
    assert.equal(apiResponseCapture.status, 409);
    await updateAlbum(
        apiRequest(['not-an-object-id']) as any,
        apiResponse as any,
        (error) => { throw error; }
    );
    assert.equal(apiResponseCapture.status, 409);
    const unchangedApiAlbum = await getDb()!.collection('albums').findOne({ _id: apiAlbumId });
    assert.equal(unchangedApiAlbum!.title, 'API Before');
    assert.equal(unchangedApiAlbum!.coverArtId, previousCoverArtId);
    assert.deepEqual(unchangedApiAlbum!.audioTrackIds, [apiReadyTrackId.toHexString()]);
    assert.equal(
        (await getDb()!.collection('audioTracks').findOne({ _id: apiReadyTrackId }))!.albumId,
        apiAlbumId.toHexString()
    );
    assert.equal(
        (await getDb()!.collection('audioTracks').findOne({ _id: apiPendingTrackId }))!.albumId,
        ''
    );

    const webAlbumId = new ObjectId();
    const firstWebTrackId = new ObjectId();
    const secondWebTrackId = new ObjectId();
    await Promise.all([
        getDb()!.collection('albums').insertOne({
            _id: webAlbumId,
            title: 'Web Before',
            audioTrackIds: [],
            lifecycleStatus: 'ready',
            referenceRevision: 0
        }),
        getDb()!.collection('audioTracks').insertMany([
            {
                _id: firstWebTrackId,
                albumId: '',
                uploadStatus: 'ready',
                s3Key: firstWebTrackId.toHexString(),
                publicationStatus: 'ready'
            },
            {
                _id: secondWebTrackId,
                albumId: '',
                uploadStatus: 'ready',
                s3Key: secondWebTrackId.toHexString(),
                publicationStatus: 'ready'
            }
        ])
    ]);
    let redirectTarget = '';
    await updateAlbumWeb({
        auth: { userId: new ObjectId().toHexString(), role: 'admin' },
        body: {
            albumId: webAlbumId.toHexString(),
            title: 'Web After',
            removeCoverArt: 'true',
            audioTrackIds: [
                secondWebTrackId.toHexString(),
                firstWebTrackId.toHexString(),
                secondWebTrackId.toHexString()
            ].join(',')
        }
    } as any, {
        redirect(target: string) {
            redirectTarget = target;
            return this;
        }
    } as any, (error) => { throw error; });

    assert.match(redirectTarget, /Album%20updated%20successfully/);
    const updatedWebAlbum = await getDb()!.collection('albums').findOne({ _id: webAlbumId });
    assert.equal(updatedWebAlbum!.title, 'Web After');
    assert.deepEqual(updatedWebAlbum!.audioTrackIds, [
        secondWebTrackId.toHexString(),
        firstWebTrackId.toHexString()
    ]);
    assert.equal(
        (await getDb()!.collection('audioTracks').findOne({ _id: firstWebTrackId }))!.albumId,
        webAlbumId.toHexString()
    );
    assert.equal(
        (await getDb()!.collection('audioTracks').findOne({ _id: secondWebTrackId }))!.albumId,
        webAlbumId.toHexString()
    );
});

test('published Track metadata, cover CAS, Artist fence, and Album move are atomic', async () => {
    const oldAlbumId = new ObjectId();
    const newAlbumId = new ObjectId();
    const trackId = new ObjectId();
    const artistId = new ObjectId();
    const oldCoverArtId = new ObjectId().toHexString();
    const newCoverArtId = new ObjectId().toHexString();
    await Promise.all([
        getDb()!.collection('albums').insertMany([
            {
                _id: oldAlbumId,
                audioTrackIds: [trackId.toHexString().toUpperCase()],
                lifecycleStatus: 'ready',
                referenceRevision: 0
            },
            {
                _id: newAlbumId,
                audioTrackIds: [],
                lifecycleStatus: 'ready',
                referenceRevision: 0
            }
        ]),
        getDb()!.collection('artists').insertOne({
            _id: artistId,
            lifecycleStatus: 'ready',
            referenceRevision: 0
        }),
        getDb()!.collection('audioTracks').insertOne({
            _id: trackId,
            title: 'Before Track Move',
            coverArtId: oldCoverArtId,
            albumId: oldAlbumId.toHexString().toUpperCase(),
            artistIds: [],
            uploadStatus: 'ready',
            s3Key: trackId.toHexString(),
            publicationStatus: 'ready',
            contentReferenceRevision: 0
        })
    ]);

    await AudioTrack.updateWithAlbumAndCoverArtById(
        trackId.toHexString(),
        newAlbumId.toHexString(),
        oldCoverArtId,
        {
            title: 'After Track Move',
            coverArtId: newCoverArtId,
            artistIds: [artistId.toHexString().toUpperCase()]
        }
    );

    const moved = await getDb()!.collection('audioTracks').findOne({ _id: trackId });
    assert.equal(moved!.title, 'After Track Move');
    assert.equal(moved!.coverArtId, newCoverArtId);
    assert.deepEqual(moved!.artistIds, [artistId.toHexString()]);
    assert.equal(moved!.albumId, newAlbumId.toHexString());
    assert.deepEqual(
        (await getDb()!.collection('albums').findOne({ _id: oldAlbumId }))!.audioTrackIds,
        []
    );
    assert.deepEqual(
        (await getDb()!.collection('albums').findOne({ _id: newAlbumId }))!.audioTrackIds,
        [trackId.toHexString()]
    );

    await assert.rejects(AudioTrack.updateWithAlbumAndCoverArtById(
        trackId.toHexString(),
        oldAlbumId.toHexString(),
        oldCoverArtId,
        { title: 'CAS Must Roll Back', coverArtId: new ObjectId().toHexString() }
    ));
    assert.equal(
        (await getDb()!.collection('audioTracks').findOne({ _id: trackId }))!.albumId,
        newAlbumId.toHexString()
    );
    assert.deepEqual(
        (await getDb()!.collection('albums').findOne({ _id: newAlbumId }))!.audioTrackIds,
        [trackId.toHexString()]
    );
});

test('upload-ready unpublished Tracks stage or clear Album targets without public exposure', async () => {
    const oldAlbumId = new ObjectId();
    const newAlbumId = new ObjectId();
    const pendingTrackId = new ObjectId();
    const failedTrackId = new ObjectId();
    await Promise.all([
        getDb()!.collection('albums').insertMany([
            {
                _id: oldAlbumId,
                title: 'Old Staged Album',
                audioTrackIds: [
                    pendingTrackId.toHexString().toUpperCase(),
                    failedTrackId
                ],
                lifecycleStatus: 'ready',
                referenceRevision: 0
            },
            {
                _id: newAlbumId,
                title: 'New Staged Album',
                audioTrackIds: [],
                lifecycleStatus: 'ready',
                referenceRevision: 0
            }
        ]),
        getDb()!.collection('audioTracks').insertMany([
            {
                _id: pendingTrackId,
                title: 'Pending Stage',
                albumId: oldAlbumId.toHexString().toUpperCase(),
                uploadStatus: 'ready',
                s3Key: pendingTrackId.toHexString(),
                publicationStatus: 'pending'
            },
            {
                _id: failedTrackId,
                title: 'Failed Clear',
                albumId: oldAlbumId,
                uploadStatus: 'ready',
                s3Key: failedTrackId.toHexString(),
                publicationStatus: 'failed'
            }
        ])
    ]);

    await AudioTrack.updateWithAlbumById(
        pendingTrackId.toHexString(),
        newAlbumId.toHexString(),
        { title: 'Pending Retargeted' }
    );
    await AudioTrack.updateWithAlbumById(failedTrackId.toHexString(), '', {});

    assert.deepEqual(
        (await getDb()!.collection('albums').findOne({ _id: oldAlbumId }))!.audioTrackIds,
        []
    );
    assert.deepEqual(
        (await getDb()!.collection('albums').findOne({ _id: newAlbumId }))!.audioTrackIds,
        []
    );
    assert.equal(
        (await getDb()!.collection('audioTracks').findOne({ _id: pendingTrackId }))!.albumId,
        newAlbumId.toHexString()
    );
    assert.equal(
        (await getDb()!.collection('audioTracks').findOne({ _id: failedTrackId }))!.albumId,
        ''
    );
    assert.deepEqual(await listPublicAudioTracks(20, 0), []);

    const report = await retryAudioTrackPublications([
        pendingTrackId.toHexString(),
        failedTrackId.toHexString()
    ]);
    assert.deepEqual(report.results.map((result) => result.outcome), ['ready', 'ready']);
    assert.deepEqual(
        (await getDb()!.collection('albums').findOne({ _id: newAlbumId }))!.audioTrackIds,
        [pendingTrackId.toHexString()]
    );
    assert.equal(
        (await getDb()!.collection('audioTracks').findOne({ _id: failedTrackId }))!.publicationStatus,
        'ready'
    );
    assert.equal((await listPublicAudioTracks(20, 0)).length, 2);
});

test('Album save reassigns existing ready Tracks before publishing the new owner', async () => {
    const creatorId = new ObjectId();
    const oldAlbumId = new ObjectId();
    const newAlbumId = new ObjectId();
    const trackId = new ObjectId();
    await Promise.all([
        getDb()!.collection('users').insertOne({ _id: creatorId, role: 'admin' }),
        getDb()!.collection('albums').insertOne({
            _id: oldAlbumId,
            title: 'Old Owner',
            audioTrackIds: [trackId],
            lifecycleStatus: 'ready',
            referenceRevision: 0
        }),
        getDb()!.collection('audioTracks').insertOne({
            _id: trackId,
            albumId: oldAlbumId.toHexString(),
            uploadStatus: 'ready',
            s3Key: trackId.toHexString()
        })
    ]);
    const album = new Album(
        'New Owner',
        '',
        [trackId.toHexString()],
        new SimpleDate(2026, 8, 5),
        creatorId.toHexString(),
        newAlbumId
    );

    await album.save();

    assert.deepEqual(
        (await getDb()!.collection('albums').findOne({ _id: oldAlbumId }))!.audioTrackIds,
        []
    );
    assert.deepEqual(
        (await getDb()!.collection('albums').findOne({ _id: newAlbumId }))!.audioTrackIds,
        [trackId.toHexString()]
    );
    assert.equal(
        (await getDb()!.collection('audioTracks').findOne({ _id: trackId }))!.albumId,
        newAlbumId.toHexString()
    );
});

test('publication retry reuses ready uploaded objects and reports each requested ID', async () => {
    const albumId = new ObjectId();
    const pendingTrackId = new ObjectId();
    const failedTrackId = new ObjectId();
    const nonReadyTrackId = new ObjectId();
    const missingTrackId = new ObjectId();
    await Promise.all([
        getDb()!.collection('albums').insertOne({
            _id: albumId,
            title: 'Retry Album',
            audioTrackIds: [],
            lifecycleStatus: 'ready',
            referenceRevision: 0
        }),
        getDb()!.collection('audioTracks').insertMany([
            {
                _id: pendingTrackId,
                title: 'Pending Retry',
                albumId: albumId.toHexString(),
                uploadStatus: 'ready',
                s3Key: pendingTrackId.toHexString(),
                publicationStatus: 'pending'
            },
            {
                _id: failedTrackId,
                title: 'Failed Retry',
                albumId: albumId.toHexString(),
                uploadStatus: 'ready',
                s3Key: failedTrackId.toHexString(),
                publicationStatus: 'failed',
                publicationError: 'previous failure'
            },
            {
                _id: nonReadyTrackId,
                title: 'Non-ready Retry',
                albumId: albumId.toHexString(),
                uploadStatus: 'pending',
                s3Key: nonReadyTrackId.toHexString(),
                publicationStatus: 'pending'
            }
        ])
    ]);

    const report = await retryAudioTrackPublications([
        pendingTrackId.toHexString(),
        pendingTrackId.toHexString(),
        'not-an-object-id',
        nonReadyTrackId.toHexString(),
        failedTrackId.toHexString(),
        missingTrackId.toHexString()
    ]);

    assert.equal(report.requestedCount, 6);
    assert.equal(report.readyCount, 2);
    assert.equal(report.failedCount, 4);
    assert.deepEqual(report.results.map((result) => ({
        audioTrackId: result.audioTrackId,
        uploadStatus: result.uploadStatus,
        publicationStatus: result.publicationStatus,
        outcome: result.outcome
    })), [
        {
            audioTrackId: pendingTrackId.toHexString(),
            uploadStatus: 'ready',
            publicationStatus: 'ready',
            outcome: 'ready'
        },
        {
            audioTrackId: pendingTrackId.toHexString(),
            uploadStatus: 'duplicate',
            publicationStatus: 'duplicate',
            outcome: 'duplicate'
        },
        {
            audioTrackId: 'not-an-object-id',
            uploadStatus: 'invalid',
            publicationStatus: 'invalid',
            outcome: 'invalid'
        },
        {
            audioTrackId: nonReadyTrackId.toHexString(),
            uploadStatus: 'pending',
            publicationStatus: 'pending',
            outcome: 'failed'
        },
        {
            audioTrackId: failedTrackId.toHexString(),
            uploadStatus: 'ready',
            publicationStatus: 'ready',
            outcome: 'ready'
        },
        {
            audioTrackId: missingTrackId.toHexString(),
            uploadStatus: 'missing',
            publicationStatus: 'missing',
            outcome: 'notFound'
        }
    ]);
    assert.deepEqual(
        (await getDb()!.collection('albums').findOne({ _id: albumId }))!.audioTrackIds,
        [pendingTrackId.toHexString(), failedTrackId.toHexString()]
    );
});

test('publication retry treats only a missing status as legacy and isolates explicit invalid states', async () => {
    const albumId = new ObjectId();
    const legacyTrackId = new ObjectId();
    const nullTrackId = new ObjectId();
    const emptyTrackId = new ObjectId();
    const unknownTrackId = new ObjectId();
    await Promise.all([
        getDb()!.collection('albums').insertOne({
            _id: albumId,
            audioTrackIds: [],
            lifecycleStatus: 'ready',
            referenceRevision: 0
        }),
        getDb()!.collection('audioTracks').insertMany([
            {
                _id: legacyTrackId,
                albumId: albumId.toHexString(),
                uploadStatus: 'ready',
                s3Key: legacyTrackId.toHexString()
            },
            {
                _id: nullTrackId,
                albumId: albumId.toHexString(),
                uploadStatus: 'ready',
                s3Key: nullTrackId.toHexString(),
                publicationStatus: null
            },
            {
                _id: emptyTrackId,
                albumId: albumId.toHexString(),
                uploadStatus: 'ready',
                s3Key: emptyTrackId.toHexString(),
                publicationStatus: ''
            },
            {
                _id: unknownTrackId,
                albumId: albumId.toHexString(),
                uploadStatus: 'ready',
                s3Key: unknownTrackId.toHexString(),
                publicationStatus: 'unexpected'
            }
        ])
    ]);

    const report = await retryAudioTrackPublications([
        legacyTrackId.toHexString(),
        nullTrackId.toHexString(),
        emptyTrackId.toHexString(),
        unknownTrackId.toHexString()
    ]);

    assert.deepEqual(report.results.map((result) => ({
        before: result.publicationStatusBefore,
        status: result.publicationStatus,
        outcome: result.outcome
    })), [
        { before: 'legacy', status: 'legacy', outcome: 'ready' },
        { before: 'null', status: 'null', outcome: 'failed' },
        { before: '', status: '', outcome: 'failed' },
        { before: 'unexpected', status: 'unexpected', outcome: 'failed' }
    ]);
    assert.deepEqual(
        (await getDb()!.collection('albums').findOne({ _id: albumId }))!.audioTrackIds,
        [legacyTrackId.toHexString()]
    );
});

test('publication retry endpoint returns 200 with isolated invalid, duplicate, missing, and non-ready outcomes', async () => {
    const missingTrackId = new ObjectId();
    const nonReadyTrackId = new ObjectId();
    await getDb()!.collection('audioTracks').insertOne({
        _id: nonReadyTrackId,
        uploadStatus: 'pending',
        s3Key: nonReadyTrackId.toHexString(),
        publicationStatus: 'pending'
    });
    let statusCode = 0;
    let body: any;
    const response = {
        setHeader: () => undefined,
        status(code: number) {
            statusCode = code;
            return this;
        },
        json(value: unknown) {
            body = value;
            return value;
        }
    };

    await postAudioPublicationRetry({
        body: {
            audioTrackIds: [
                'invalid-id',
                missingTrackId.toHexString(),
                missingTrackId.toHexString(),
                nonReadyTrackId.toHexString()
            ]
        }
    } as any, response as any, (error) => { throw error; });

    assert.equal(statusCode, 200);
    assert.deepEqual(body.results.map((result: any) => result.outcome), [
        'invalid',
        'notFound',
        'duplicate',
        'failed'
    ]);
});

test('uploaded Soundtracks become public only with their canonical Album link', async () => {
    const albumId = new ObjectId();
    const trackId = new ObjectId();
    const failedTrackId = new ObjectId();
    await Promise.all([
        getDb()!.collection('albums').insertOne({
            _id: albumId,
            title: 'Publication Album',
            audioTrackIds: [],
            lifecycleStatus: 'ready',
            referenceRevision: 0
        }),
        getDb()!.collection('audioTracks').insertMany([
            {
                _id: trackId,
                title: 'Pending Publication Track',
                albumId: albumId.toHexString(),
                uploadStatus: 'ready',
                s3Key: trackId.toHexString(),
                publicationStatus: 'pending',
                publicationUpdatedAt: new Date()
            },
            {
                _id: failedTrackId,
                title: 'Failed Publication Track',
                albumId: new ObjectId().toHexString(),
                uploadStatus: 'ready',
                s3Key: failedTrackId.toHexString(),
                publicationStatus: 'pending',
                publicationUpdatedAt: new Date()
            }
        ])
    ]);

    assert.deepEqual(await listPublicAudioTracks(20, 0), []);
    await assert.rejects(
        publishUploadedAudioTracks(
            (await getDb()!.collection('audioTracks').findOne({ _id: failedTrackId }))!.albumId,
            [failedTrackId.toHexString()]
        )
    );
    assert.equal(
        (await getDb()!.collection('audioTracks').findOne({ _id: failedTrackId }))!
            .publicationStatus,
        'failed'
    );
    assert.deepEqual(
        (await getDb()!.collection('albums').findOne({ _id: albumId }))!.audioTrackIds,
        []
    );

    await publishUploadedAudioTracks(albumId.toHexString(), [trackId.toHexString()]);
    const [publishedTrack] = await listPublicAudioTracks(20, 0);
    assert.equal(publishedTrack._id, trackId.toHexString());
    assert.equal(publishedTrack.albumId, albumId.toHexString());
    assert.deepEqual(
        (await getDb()!.collection('albums').findOne({ _id: albumId }))!.audioTrackIds,
        [trackId.toHexString()]
    );
    assert.equal(
        (await getDb()!.collection('audioTracks').findOne({ _id: trackId }))!
            .publicationStatus,
        'ready'
    );
});

test('a stale Carousel rewrite cannot resurrect a deleted Album reference', async () => {
    const albumId = new ObjectId();
    const carouselId = new ObjectId();
    const staleItems = [{
        contentType: 'album' as const,
        contentId: albumId.toHexString(),
        order: 0
    }];
    await Promise.all([
        getDb()!.collection('albums').insertOne({
            _id: albumId,
            title: 'Stale Carousel Album',
            lifecycleStatus: 'ready',
            referenceRevision: 0
        }),
        getDb()!.collection('carousels').insertOne({
            _id: carouselId,
            name: 'Stale Carousel',
            mode: 'manual',
            items: staleItems
        })
    ]);

    assert.equal((await deleteAlbumAndReferences(albumId.toHexString())).ownerDeleted, true);
    assert.deepEqual(
        (await getDb()!.collection('carousels').findOne({ _id: carouselId }))!.items,
        []
    );
    await assert.rejects(
        Carousel.updateById(carouselId.toHexString(), { items: staleItems }),
        (error: any) => error?.code === 'album_reference_unavailable'
    );
    assert.deepEqual(
        (await getDb()!.collection('carousels').findOne({ _id: carouselId }))!.items,
        []
    );
});

test('moving Carousel items persists the normalized fenced identity', async () => {
    const albumId = new ObjectId();
    const sourceId = new ObjectId();
    const targetId = new ObjectId();
    await Promise.all([
        getDb()!.collection('albums').insertOne({
            _id: albumId,
            title: 'Normalized Move Album',
            lifecycleStatus: 'ready',
            referenceRevision: 0
        }),
        getDb()!.collection('carousels').insertMany([
            {
                _id: sourceId,
                name: 'Source',
                mode: 'manual',
                items: [{
                    contentType: 'album',
                    contentId: albumId.toHexString().toUpperCase(),
                    order: 0
                }]
            },
            { _id: targetId, name: 'Target', mode: 'manual', items: [] }
        ])
    ]);

    await Carousel.moveItemBetweenCarousels(
        sourceId.toHexString(),
        targetId.toHexString(),
        0,
        0,
        new ObjectId().toHexString()
    );
    const [source, target] = await Promise.all([
        getDb()!.collection('carousels').findOne({ _id: sourceId }),
        getDb()!.collection('carousels').findOne({ _id: targetId })
    ]);
    assert.deepEqual(source!.items, []);
    assert.equal(target!.items[0].contentId, albumId.toHexString());
});

test('Library writes roll back catalog touches when the account deletion fence has won', async () => {
    const albumId = new ObjectId();
    const deletedUserId = new ObjectId();
    await getDb()!.collection('albums').insertOne({
        _id: albumId,
        title: 'Account Fence Album',
        lifecycleStatus: 'ready',
        referenceRevision: 0
    });

    await assert.rejects(
        UserLibrary.save(deletedUserId.toHexString(), 'album', albumId.toHexString()),
        (error: any) => error?.code === 'account_unavailable'
    );
    assert.equal(await getDb()!.collection('userSaves').countDocuments({}), 0);
    assert.equal(await getDb()!.collection('userActivity').countDocuments({}), 0);
    assert.equal(
        (await getDb()!.collection('albums').findOne({ _id: albumId }))!.referenceRevision,
        0
    );
});
