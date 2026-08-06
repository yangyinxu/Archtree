import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { ObjectId } from 'mongodb';

import { getDb } from '../src/infrastructure/database';
import { AudioTrack } from '../src/models/audioTrack';
import { Album } from '../src/models/album';
import { readyAudioStorageFilter } from '../src/utils/audioStorageKey';
import { updateCoverArtOwnerAndCleanup } from '../src/services/imageStorageService';
import {
    MongoReplicaSetHarness,
    startMongoReplicaSet
} from './support/mongoReplicaSet';
import { deleteAudioObjectAndTrack } from '../src/services/audioStorageService';
import { withReadyAudioTrackReferences } from '../src/services/audioTrackReferenceFenceService';
import { cleanupDeletedContentReferences } from '../src/services/contentReferenceService';

let harness: MongoReplicaSetHarness | undefined;

before(async () => {
    harness = await startMongoReplicaSet('archtree-audio-track-lifecycle-test');
});

beforeEach(async () => {
    await Promise.all([
        'albums',
        'audioTracks',
        'carousels',
        'contentCollections',
        'userSaves',
        'userActivity',
        'users'
    ].map((collection) => getDb()!.collection(collection).deleteMany({})));
});

after(async () => {
    await harness?.stop();
});

test('delete-first Soundtrack fencing rejects later metadata and cover attachment writes', async () => {
    for (const uploadStatus of ['deleting', 'deleteFailed']) {
        const trackId = new ObjectId();
        await getDb()!.collection('audioTracks').insertOne({
            _id: trackId,
            title: 'Original title',
            coverArtId: null,
            uploadStatus,
            s3Key: trackId.toHexString()
        });

        await assert.rejects(
            AudioTrack.updateById(trackId.toHexString(), { title: 'Late title' }),
            (error: any) => error?.code === 'audio_track_mutation_unavailable'
        );
        const coverAttachment = await updateCoverArtOwnerAndCleanup(
            trackId.toHexString(),
            { coverArtId: new ObjectId().toHexString() },
            null,
            false,
            {
                ownerType: 'audioTrack',
                updateOwner: (id, update) => AudioTrack.updateById(id, update)
            }
        );
        assert.equal(coverAttachment.updateApplied, false);
        assert.equal(
            (coverAttachment.cleanupError as any)?.code,
            'audio_track_mutation_unavailable'
        );
        assert.equal(coverAttachment.cleanupPending, false);

        const retained = await getDb()!.collection('audioTracks').findOne({ _id: trackId });
        assert.equal(retained!.title, 'Original title');
        assert.equal(retained!.coverArtId, null);
    }
});

test('ready Soundtrack queries require an object key bound to the row identity', async () => {
    const legacyId = new ObjectId();
    const versionedId = new ObjectId();
    const invalidId = new ObjectId();
    await getDb()!.collection('audioTracks').insertMany([
        {
            _id: legacyId,
            uploadStatus: 'ready',
            s3Key: legacyId.toHexString()
        },
        {
            _id: versionedId,
            uploadStatus: 'ready',
            s3Key: `audio/${versionedId.toHexString()}/${new ObjectId().toHexString()}`
        },
        {
            _id: invalidId,
            uploadStatus: 'ready',
            s3Key: legacyId.toHexString()
        }
    ]);

    const ready = await getDb()!.collection('audioTracks')
        .find(readyAudioStorageFilter)
        .sort({ _id: 1 })
        .toArray();
    assert.deepEqual(
        new Set(ready.map((track) => String(track._id))),
        new Set([legacyId.toHexString(), versionedId.toHexString()])
    );
});

test('a committed external Soundtrack reference is observed by concurrent deletion', async () => {
    const trackId = new ObjectId();
    const albumId = new ObjectId();
    await getDb()!.collection('audioTracks').insertOne({
        _id: trackId,
        title: 'Reference first',
        uploadStatus: 'ready',
        s3Key: trackId.toHexString()
    });
    let releaseReference!: () => void;
    const referencePaused = new Promise<void>((resolve) => { releaseReference = resolve; });
    let referenceWritten!: () => void;
    const written = new Promise<void>((resolve) => { referenceWritten = resolve; });
    const reference = withReadyAudioTrackReferences(
        [trackId.toHexString()],
        async (session, audioTrackIds) => {
            await getDb()!.collection('albums').insertOne({
                _id: albumId,
                title: 'Concurrent Track Album',
                audioTrackIds,
                lifecycleStatus: 'ready',
                referenceRevision: 0
            }, { session });
            referenceWritten();
            await referencePaused;
        }
    );
    await written;

    const deletion = deleteAudioObjectAndTrack(trackId.toHexString(), {
        deleteAudioObject: async () => undefined,
        prepareTrackCoverArtDeletion: async () => false,
        finalizeTrackCoverArtDeletion: async () => undefined
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseReference();
    await reference;
    await deletion;

    assert.deepEqual(
        (await getDb()!.collection('albums').findOne({ _id: albumId }))!.audioTrackIds,
        []
    );
});

test('a deleting Soundtrack rejects a later Album reference write', async () => {
    const trackId = new ObjectId();
    const albumId = new ObjectId();
    await Promise.all([
        getDb()!.collection('audioTracks').insertOne({
            _id: trackId,
            title: 'Deletion first',
            uploadStatus: 'ready',
            s3Key: trackId.toHexString()
        }),
        getDb()!.collection('albums').insertOne({
            _id: albumId,
            title: 'Existing Album',
            audioTrackIds: [],
            lifecycleStatus: 'ready',
            referenceRevision: 0
        })
    ]);
    let releaseCleanup!: () => void;
    const cleanupPaused = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    let deletionTransitioned!: () => void;
    const transitioned = new Promise<void>((resolve) => { deletionTransitioned = resolve; });
    const deletion = deleteAudioObjectAndTrack(trackId.toHexString(), {
        deleteAudioObject: async () => undefined,
        prepareTrackCoverArtDeletion: async () => false,
        finalizeTrackCoverArtDeletion: async () => undefined,
        cleanupReferences: async (type, contentId) => {
            deletionTransitioned();
            await cleanupPaused;
            await cleanupDeletedContentReferences(type, contentId);
        }
    });
    await transitioned;

    await assert.rejects(
        Album.updateById(albumId.toHexString(), { audioTrackIds: [trackId.toHexString()] }),
        (error: any) => error?.code === 'audio_track_reference_unavailable'
    );
    releaseCleanup();
    await deletion;
    assert.deepEqual(
        (await getDb()!.collection('albums').findOne({ _id: albumId }))!.audioTrackIds,
        []
    );
});
