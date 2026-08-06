import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { ObjectId } from 'mongodb';

import { getDb } from '../src/infrastructure/database';
import { Artist } from '../src/models/artist';
import { AudioFormat, AudioTrack } from '../src/models/audioTrack';
import { Carousel } from '../src/models/carousel';
import { SimpleDate } from '../src/models/simpleDate';
import {
    ArtistDeletionOutcomeUnknownError,
    deleteArtistAndReferences
} from '../src/services/artistLifecycleService';
import { withReadyArtistReferences } from '../src/services/artistReferenceFenceService';
import { cleanupDeletedContentReferences } from '../src/services/contentReferenceService';
import {
    getPublicArtist,
    listPublicArtists,
    listPublicAudioTracks,
    searchPublicCatalog
} from '../src/services/publicCatalogService';
import {
    getListenerArtist,
    searchListenerContent
} from '../src/services/listenerContentService';
import { toPlaylistDetail } from '../src/services/playlistProjectionService';
import { updateAudioTrack } from '../src/controllers/audioTrackController';
import {
    MongoReplicaSetHarness,
    startMongoReplicaSet
} from './support/mongoReplicaSet';

let harness: MongoReplicaSetHarness | undefined;

const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
};

const artistCarouselConfig = (artistId: string) => ({
    artistId,
    contentType: 'audioTrack' as const,
    sort: 'titleAsc' as const,
    limit: 20
});

before(async () => {
    harness = await startMongoReplicaSet('archtree-artist-lifecycle-test');
});

beforeEach(async () => {
    await Promise.all([
        'albums',
        'artists',
        'audioTracks',
        'carousels',
        'imageAssets',
        'playlists'
    ].map((collection) => getDb()!.collection(collection).deleteMany({})));
});

after(async () => {
    await harness?.stop();
});

test('a committed Artist reference is observed and removed by a concurrent deletion', async () => {
    const artistId = new ObjectId();
    const trackId = new ObjectId();
    await getDb()!.collection('artists').insertOne({
        _id: artistId,
        name: 'Reference first',
        albumIds: []
    });

    const referenceWritten = deferred();
    const releaseReference = deferred();
    const reference = withReadyArtistReferences(
        [artistId.toHexString()],
        async (session, artistIds) => {
            await getDb()!.collection('audioTracks').insertOne({
                _id: trackId,
                title: 'Concurrent reference',
                artistIds
            }, { session });
            referenceWritten.resolve();
            await releaseReference.promise;
        }
    );
    await referenceWritten.promise;

    const deletion = deleteArtistAndReferences(artistId.toHexString());
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseReference.resolve();

    await reference;
    const outcome = await deletion;
    assert.equal(outcome.ownerDeleted, true);
    assert.equal(await getDb()!.collection('artists').findOne({ _id: artistId }), null);
    assert.deepEqual(
        (await getDb()!.collection('audioTracks').findOne({ _id: trackId }))!.artistIds,
        []
    );
});

test('a deleting Artist rejects every supported new-reference write atomically', async () => {
    const artistId = new ObjectId();
    const albumId = new ObjectId();
    const existingTrackId = new ObjectId();
    const newTrackId = new ObjectId();
    const existingCarouselId = new ObjectId();
    const newCarouselId = new ObjectId();
    await Promise.all([
        getDb()!.collection('artists').insertOne({
            _id: artistId,
            name: 'Deletion first',
            albumIds: [],
            lifecycleStatus: 'ready',
            referenceRevision: 0
        }),
        getDb()!.collection('albums').insertOne({ _id: albumId, title: 'Fence Album' }),
        getDb()!.collection('audioTracks').insertOne({
            _id: existingTrackId,
            title: 'Existing Track',
            artistIds: []
        }),
        getDb()!.collection('carousels').insertOne({
            _id: existingCarouselId,
            name: 'Existing Carousel',
            mode: 'manual',
            items: []
        })
    ]);

    const deletionTransitioned = deferred();
    const releaseCleanup = deferred();
    const deletion = deleteArtistAndReferences(artistId.toHexString(), {
        cleanupReferences: async (type, contentId) => {
            deletionTransitioned.resolve();
            await releaseCleanup.promise;
            await cleanupDeletedContentReferences(type, contentId);
        }
    });
    await deletionTransitioned.promise;

    const newTrack = new AudioTrack(
        'New Track',
        [artistId.toHexString()],
        [],
        '',
        new SimpleDate(),
        '',
        new AudioFormat('MP3'),
        '',
        'admin',
        'new.mp3',
        'audio/mpeg',
        newTrackId
    );
    const newCarousel = new Carousel(
        'New Artist Carousel',
        [],
        'admin',
        'admin',
        'artist',
        artistCarouselConfig(artistId.toHexString())
    );
    (newCarousel as any)._id = newCarouselId;

    const writes = await Promise.allSettled([
        newTrack.save(),
        AudioTrack.updateById(existingTrackId.toHexString(), {
            artistIds: [artistId.toHexString()]
        }),
        newCarousel.save(),
        Carousel.updateById(existingCarouselId.toHexString(), {
            mode: 'artist',
            artistConfig: artistCarouselConfig(artistId.toHexString()),
            items: []
        }),
        Artist.updateById(artistId.toHexString(), {
            albumIds: [albumId.toHexString()]
        })
    ]);
    assert.equal(writes.every((result) => result.status === 'rejected'), true);
    for (const result of writes) {
        if (result.status === 'rejected') {
            assert.equal((result.reason as any)?.code, 'artist_reference_unavailable');
        }
    }

    assert.equal(await getDb()!.collection('audioTracks').findOne({ _id: newTrackId }), null);
    assert.deepEqual(
        (await getDb()!.collection('audioTracks').findOne({ _id: existingTrackId }))!.artistIds,
        []
    );
    assert.equal(await getDb()!.collection('carousels').findOne({ _id: newCarouselId }), null);
    assert.equal(
        (await getDb()!.collection('carousels').findOne({ _id: existingCarouselId }))!.mode,
        'manual'
    );
    assert.deepEqual(
        (await getDb()!.collection('artists').findOne({ _id: artistId }))!.albumIds,
        []
    );

    releaseCleanup.resolve();
    assert.equal((await deletion).ownerDeleted, true);
});

test('cover CAS plus Artist references obey the deletion fence and the JSON combined path', async () => {
    const deletingArtistId = new ObjectId();
    const fencedTrackId = new ObjectId();
    await Promise.all([
        getDb()!.collection('artists').insertOne({
            _id: deletingArtistId,
            name: 'Deleting Cover Artist',
            lifecycleStatus: 'ready',
            referenceRevision: 0
        }),
        getDb()!.collection('audioTracks').insertOne({
            _id: fencedTrackId,
            title: 'Before Fenced Cover',
            artistIds: [],
            coverArtId: null,
            coverArtUrl: '',
            uploadStatus: 'ready',
            s3Key: fencedTrackId.toHexString(),
            publicationStatus: 'ready'
        })
    ]);
    const deletionTransitioned = deferred();
    const releaseCleanup = deferred();
    const deletion = deleteArtistAndReferences(deletingArtistId.toHexString(), {
        cleanupReferences: async (type, contentId) => {
            deletionTransitioned.resolve();
            await releaseCleanup.promise;
            await cleanupDeletedContentReferences(type, contentId);
        }
    });
    await deletionTransitioned.promise;

    await assert.rejects(
        AudioTrack.updateCoverArtById(fencedTrackId.toHexString(), null, {
            title: 'Must Roll Back',
            coverArtId: null,
            artistIds: [deletingArtistId.toHexString()]
        }),
        (error: any) => error?.code === 'artist_reference_unavailable'
    );
    const fencedTrack = await getDb()!.collection('audioTracks').findOne({ _id: fencedTrackId });
    assert.equal(fencedTrack!.title, 'Before Fenced Cover');
    assert.deepEqual(fencedTrack!.artistIds, []);
    releaseCleanup.resolve();
    assert.equal((await deletion).ownerDeleted, true);

    const committedArtistId = new ObjectId();
    const committedTrackId = new ObjectId();
    const committedCoverArtId = new ObjectId().toHexString();
    await Promise.all([
        getDb()!.collection('artists').insertOne({
            _id: committedArtistId,
            name: 'Committed Cover Artist',
            lifecycleStatus: 'ready',
            referenceRevision: 0
        }),
        getDb()!.collection('audioTracks').insertOne({
            _id: committedTrackId,
            title: 'Before Commit',
            artistIds: [],
            coverArtId: null,
            coverArtUrl: '',
            uploadStatus: 'ready',
            s3Key: committedTrackId.toHexString(),
            publicationStatus: 'ready'
        })
    ]);
    await AudioTrack.updateCoverArtById(committedTrackId.toHexString(), null, {
        title: 'Committed Before Delete',
        coverArtId: committedCoverArtId,
        artistIds: [committedArtistId.toHexString().toUpperCase()]
    });
    assert.equal((await deleteArtistAndReferences(committedArtistId.toHexString())).ownerDeleted, true);
    const cleanedTrack = await getDb()!.collection('audioTracks').findOne({ _id: committedTrackId });
    assert.equal(cleanedTrack!.title, 'Committed Before Delete');
    assert.equal(cleanedTrack!.coverArtId, committedCoverArtId);
    assert.deepEqual(cleanedTrack!.artistIds, []);

    const controllerArtistId = new ObjectId();
    const controllerTrackId = new ObjectId();
    await Promise.all([
        getDb()!.collection('artists').insertOne({
            _id: controllerArtistId,
            name: 'Controller Cover Artist',
            lifecycleStatus: 'ready',
            referenceRevision: 0
        }),
        getDb()!.collection('audioTracks').insertOne({
            _id: controllerTrackId,
            title: 'Controller Before',
            artistIds: [],
            coverArtId: null,
            coverArtUrl: '',
            uploadStatus: 'ready',
            s3Key: controllerTrackId.toHexString(),
            publicationStatus: 'ready'
        })
    ]);
    let responseStatus = 0;
    await updateAudioTrack({
        auth: { userId: new ObjectId().toHexString(), role: 'admin' },
        params: { audioTrackId: controllerTrackId.toHexString() },
        body: {
            title: 'Controller After',
            artistIds: [controllerArtistId.toHexString().toUpperCase()],
            removeCoverArt: 'true'
        }
    } as any, {
        status(status: number) {
            responseStatus = status;
            return this;
        },
        json() { return this; }
    } as any, (error) => { throw error; });
    assert.equal(responseStatus, 200);
    const controllerTrack = await getDb()!.collection('audioTracks').findOne({
        _id: controllerTrackId
    });
    assert.equal(controllerTrack!.title, 'Controller After');
    assert.deepEqual(controllerTrack!.artistIds, [controllerArtistId.toHexString()]);
});

test('failed Artist reference cleanup retains evidence and a retry completes deletion', async () => {
    const artistId = new ObjectId();
    const trackId = new ObjectId();
    const carouselId = new ObjectId();
    await Promise.all([
        getDb()!.collection('artists').insertOne({
            _id: artistId,
            name: 'Retry Artist',
            albumIds: [],
            lifecycleStatus: 'ready',
            referenceRevision: 0
        }),
        getDb()!.collection('audioTracks').insertOne({
            _id: trackId,
            artistIds: [artistId.toHexString()]
        }),
        getDb()!.collection('carousels').insertOne({
            _id: carouselId,
            name: 'Retry Carousel',
            mode: 'artist',
            artistConfig: artistCarouselConfig(artistId.toHexString()),
            items: []
        })
    ]);

    const failed = await deleteArtistAndReferences(artistId.toHexString(), {
        cleanupReferences: async () => {
            throw new Error('simulated reference cleanup failure');
        }
    });
    assert.equal(failed.ownerDeleted, false);
    assert.equal(failed.cleanupPending, true);
    const retained = await getDb()!.collection('artists').findOne({ _id: artistId });
    assert.equal(retained!.lifecycleStatus, 'deleteFailed');
    assert.equal(retained!.referenceRevision, 1);
    assert.match(retained!.lifecycleError, /simulated reference cleanup failure/);
    assert.deepEqual(
        (await getDb()!.collection('audioTracks').findOne({ _id: trackId }))!.artistIds,
        [artistId.toHexString()]
    );

    const retried = await deleteArtistAndReferences(artistId.toHexString());
    assert.equal(retried.ownerDeleted, true);
    assert.equal(await getDb()!.collection('artists').findOne({ _id: artistId }), null);
    assert.deepEqual(
        (await getDb()!.collection('audioTracks').findOne({ _id: trackId }))!.artistIds,
        []
    );
    const carousel = await getDb()!.collection('carousels').findOne({ _id: carouselId });
    assert.equal(carousel!.mode, 'manual');
    assert.equal(carousel!.artistConfig, undefined);
});

test('missing Artist cover-art evidence stops deletion before references or owner are removed', async () => {
    const artistId = new ObjectId();
    const coverArtId = new ObjectId().toHexString();
    await getDb()!.collection('artists').insertOne({
        _id: artistId,
        name: 'Missing cover evidence',
        albumIds: [],
        coverArtId,
        lifecycleStatus: 'ready',
        referenceRevision: 0
    });
    let referenceCleanupCalls = 0;
    let coverFinalizationCalls = 0;

    const failed = await deleteArtistAndReferences(artistId.toHexString(), {
        prepareCoverArt: async () => false,
        cleanupReferences: async () => { referenceCleanupCalls += 1; },
        finalizeCoverArt: async () => { coverFinalizationCalls += 1; }
    });

    assert.equal(failed.deleted, false);
    assert.equal(failed.ownerDeleted, false);
    assert.equal(failed.cleanupPending, true);
    assert.equal(referenceCleanupCalls, 0);
    assert.equal(coverFinalizationCalls, 0);
    const retained = await getDb()!.collection('artists').findOne({ _id: artistId });
    assert.equal(retained!.lifecycleStatus, 'deleteFailed');
    assert.match(retained!.lifecycleError, /Cover-art lifecycle evidence is missing/);

    const retried = await deleteArtistAndReferences(artistId.toHexString(), {
        prepareCoverArt: async () => true,
        cleanupReferences: async () => { referenceCleanupCalls += 1; },
        finalizeCoverArt: async () => { coverFinalizationCalls += 1; }
    });
    assert.equal(retried.ownerDeleted, true);
    assert.equal(referenceCleanupCalls, 1);
    assert.equal(coverFinalizationCalls, 1);
    assert.equal(await getDb()!.collection('artists').findOne({ _id: artistId }), null);
});

test('Artist deletion finalizes cover evidence after a committed delete response is lost', async () => {
    const artistId = new ObjectId();
    const coverArtId = new ObjectId().toHexString();
    await getDb()!.collection('artists').insertOne({
        _id: artistId,
        name: 'Lost delete response',
        coverArtId,
        lifecycleStatus: 'ready',
        referenceRevision: 0
    });
    let finalized = 0;

    const result = await deleteArtistAndReferences(artistId.toHexString(), {
        prepareCoverArt: async () => true,
        cleanupReferences: async () => undefined,
        deleteOwner: async (id, referenceRevision) => {
            await getDb()!.collection('artists').deleteOne({
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
    assert.equal(await getDb()!.collection('artists').findOne({ _id: artistId }), null);
});

test('Artist deletion reports an unknown outcome when confirmation is unavailable', async () => {
    const artistId = new ObjectId();
    await getDb()!.collection('artists').insertOne({
        _id: artistId,
        name: 'Unknown delete outcome',
        lifecycleStatus: 'ready',
        referenceRevision: 0
    });

    await assert.rejects(
        deleteArtistAndReferences(artistId.toHexString(), {
            cleanupReferences: async () => undefined,
            deleteOwner: async () => { throw new Error('database response lost'); },
            findOwner: async () => { throw new Error('confirmation unavailable'); }
        }),
        (error: any) => error instanceof ArtistDeletionOutcomeUnknownError
            && error.cleanupPending === true
    );
});

test('legacy and ready Artists remain public while non-ready Artists disappear everywhere', async () => {
    const legacyId = new ObjectId();
    const readyId = new ObjectId();
    const deletingId = new ObjectId();
    const deleteFailedId = new ObjectId();
    const albumId = new ObjectId();
    const trackId = new ObjectId();
    await Promise.all([
        getDb()!.collection('albums').insertOne({
            _id: albumId,
            title: 'Lifecycle Album',
            audioTrackIds: []
        }),
        getDb()!.collection('artists').insertMany([
            {
                _id: legacyId,
                name: 'Lifecycle Legacy',
                albumIds: [albumId.toHexString()]
            },
            {
                _id: readyId,
                name: 'Lifecycle Ready',
                albumIds: [],
                lifecycleStatus: 'ready',
                referenceRevision: 0
            },
            {
                _id: deletingId,
                name: 'Lifecycle Deleting',
                albumIds: [],
                lifecycleStatus: 'deleting',
                referenceRevision: 1
            },
            {
                _id: deleteFailedId,
                name: 'Lifecycle Delete Failed',
                albumIds: [],
                lifecycleStatus: 'deleteFailed',
                referenceRevision: 2
            }
        ]),
        getDb()!.collection('audioTracks').insertOne({
            _id: trackId,
            title: 'Lifecycle Track',
            artistIds: [
                legacyId.toHexString(),
                readyId.toHexString(),
                deletingId.toHexString(),
                deleteFailedId.toHexString()
            ],
            uploadStatus: 'ready',
            s3Key: trackId.toHexString()
        })
    ]);

    const expectedVisible = new Set([legacyId.toHexString(), readyId.toHexString()]);
    assert.deepEqual(
        new Set((await listPublicArtists(20, 0)).map((artist) => artist._id)),
        expectedVisible
    );
    assert.equal(await getPublicArtist(deletingId.toHexString()), null);
    assert.equal((await getPublicArtist(legacyId.toHexString()))?._id, legacyId.toHexString());

    const publicSearch = await searchPublicCatalog('Lifecycle', 20);
    assert.deepEqual(new Set(publicSearch.artists.map((artist) => artist._id)), expectedVisible);
    const [publicTrack] = await listPublicAudioTracks(20, 0);
    assert.deepEqual(new Set(publicTrack.artistIds), expectedVisible);

    const listenerSearch = await searchListenerContent('Lifecycle', 20);
    assert.deepEqual(new Set(listenerSearch.artists.map((artist) => artist.id)), expectedVisible);
    assert.deepEqual(
        new Set(listenerSearch.audioTracks[0].artistNames),
        new Set(['Lifecycle Legacy', 'Lifecycle Ready'])
    );
    assert.equal(await getListenerArtist(deleteFailedId.toHexString()), null);
    assert.equal(
        (await getListenerArtist(legacyId.toHexString()))?.artist.id,
        legacyId.toHexString()
    );

    const legacyCarousel = await Carousel.resolveCarousel({
        mode: 'artist',
        artistConfig: {
            artistId: legacyId.toHexString(),
            contentType: 'album',
            sort: 'titleAsc',
            limit: 20
        }
    });
    const deletingCarousel = await Carousel.resolveCarousel({
        mode: 'artist',
        artistConfig: artistCarouselConfig(deletingId.toHexString())
    });
    assert.deepEqual(legacyCarousel.items.map((item: any) => item.contentId), [albumId.toHexString()]);
    assert.deepEqual(deletingCarousel.items, []);

    const playlist = await toPlaylistDetail({
        _id: new ObjectId(),
        ownerUserId: new ObjectId().toHexString(),
        name: 'Lifecycle attribution',
        items: [{
            itemId: 'lifecycle-track',
            audioTrackId: trackId.toHexString(),
            addedAt: new Date()
        }],
        revision: 1,
        createdAt: new Date(),
        updatedAt: new Date()
    });
    assert.deepEqual(
        new Set(playlist.items[0].audioTrack!.artistNames),
        new Set(['Lifecycle Legacy', 'Lifecycle Ready'])
    );
});
