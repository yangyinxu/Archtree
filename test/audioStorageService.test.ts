import assert from 'node:assert/strict';
import test from 'node:test';
import {
    AudioUploadDependencies,
    AudioTrackDeletionDependencies,
    deleteAudioObjectAndTrack,
    isAudioObjectKeyForTrack,
    uploadAudioObject
} from '../src/services/audioStorageService';

const trackId = '507f1f77bcf86cd799439011';
const replacementId = '507f1f77bcf86cd799439012';
const stalePendingId = '507f1f77bcf86cd799439013';
const nextReplacementId = '507f1f77bcf86cd799439014';
const originalKey = trackId;
const replacementKey = `audio/${trackId}/${replacementId}`;
const stalePendingKey = `audio/${trackId}/${stalePendingId}`;
const nextReplacementKey = `audio/${trackId}/${nextReplacementId}`;

/** Creates deterministic deletion boundaries while preserving production call order. */
const deletionDependencies = (
    calls: string[],
    updates: Array<Record<string, unknown>>
    ): AudioTrackDeletionDependencies => ({
    findTrack: async () => ({
        coverArtId: 'cover-art-id',
        s3Key: replacementKey
    }),
    beginDeletion: async (_audioTrackId, _expected, update) => {
        calls.push(`update:${String(update.uploadStatus)}`);
        updates.push(update);
        return { matchedCount: 1 };
    },
    updateTrackWhere: async (_audioTrackId, _expected, update) => {
        calls.push(`update:${String(update.uploadStatus ?? update.referenceCleanupStatus)}`);
        updates.push(update);
        return { matchedCount: 1 };
    },
    deleteAudioObject: async s3Key => { calls.push(`delete-audio-object:${s3Key}`); },
    prepareTrackCoverArtDeletion: async () => {
        calls.push('prepare-cover-art-deletion');
        return true;
    },
    finalizeTrackCoverArtDeletion: async () => { calls.push('finalize-cover-art-deletion'); },
    cleanupReferences: async () => { calls.push('cleanup-references'); },
    deleteTrack: async () => {
        calls.push('delete-track');
        return { deletedCount: 1 };
    }
});

test('Soundtrack deletion retains metadata until storage and reference cleanup finish', async () => {
    const calls: string[] = [];
    const updates: Array<Record<string, unknown>> = [];

    await deleteAudioObjectAndTrack(
        trackId,
        deletionDependencies(calls, updates)
    );

    assert.deepEqual(calls, [
        'update:deleting',
        'prepare-cover-art-deletion',
        `delete-audio-object:${replacementKey}`,
        'cleanup-references',
        'update:complete',
        'delete-track',
        'finalize-cover-art-deletion'
    ]);
    assert.equal(updates[0].referenceCleanupStatus, 'pending');
    assert.equal(updates[1].referenceCleanupStatus, 'complete');
});

test('reference cleanup failure remains recorded and retryable without deleting metadata', async () => {
    const calls: string[] = [];
    const updates: Array<Record<string, unknown>> = [];
    const dependencies = deletionDependencies(calls, updates);
    let audioObjectDeletes = 0;
    let coverArtPreparations = 0;
    let coverArtFinalizations = 0;
    let cleanupAttempts = 0;
    let trackDeletes = 0;
    dependencies.deleteAudioObject = async () => {
        audioObjectDeletes += 1;
        calls.push('delete-audio-object');
    };
    dependencies.prepareTrackCoverArtDeletion = async () => {
        coverArtPreparations += 1;
        calls.push('prepare-cover-art-deletion');
        return true;
    };
    dependencies.finalizeTrackCoverArtDeletion = async () => {
        coverArtFinalizations += 1;
        calls.push('finalize-cover-art-deletion');
    };
    dependencies.cleanupReferences = async () => {
        cleanupAttempts += 1;
        calls.push('cleanup-references');
        if (cleanupAttempts === 1) {
            throw new Error('simulated cleanup interruption');
        }
    };
    dependencies.deleteTrack = async () => {
        trackDeletes += 1;
        calls.push('delete-track');
        return { deletedCount: 1 };
    };

    await assert.rejects(
        deleteAudioObjectAndTrack(trackId, dependencies),
        /simulated cleanup interruption/
    );

    assert.equal(calls.includes('delete-track'), false);
    assert.equal(updates.at(-1)?.uploadStatus, 'deleteFailed');
    assert.equal(updates.at(-1)?.referenceCleanupStatus, 'failed');
    assert.equal(updates.at(-1)?.referenceCleanupError, 'simulated cleanup interruption');

    await deleteAudioObjectAndTrack(trackId, dependencies);

    assert.equal(audioObjectDeletes, 2);
    assert.equal(coverArtPreparations, 2);
    assert.equal(coverArtFinalizations, 1);
    assert.equal(cleanupAttempts, 2);
    assert.equal(trackDeletes, 1);
    assert.equal(updates.at(-1)?.referenceCleanupStatus, 'complete');
});

test('cover-art record finalization failure is reported after Soundtrack deletion', async () => {
    const calls: string[] = [];
    const updates: Array<Record<string, unknown>> = [];
    const dependencies = deletionDependencies(calls, updates);
    dependencies.finalizeTrackCoverArtDeletion = async () => {
        calls.push('finalize-cover-art-deletion');
        throw new Error('record cleanup interrupted');
    };

    const result = await deleteAudioObjectAndTrack(trackId, dependencies);

    assert.equal(result.cleanupPending, true);
    assert.match(String(result.cleanupError), /record cleanup interrupted/);
    assert.ok(calls.indexOf('delete-track') < calls.indexOf('finalize-cover-art-deletion'));
});

test('a committed Soundtrack delete is confirmed after its database response is lost', async () => {
    const calls: string[] = [];
    const updates: Array<Record<string, unknown>> = [];
    const dependencies = deletionDependencies(calls, updates);
    let exists = true;
    dependencies.findTrack = async () => exists ? {
        coverArtId: 'cover-art-id',
        s3Key: replacementKey
    } : null;
    dependencies.deleteTrack = async () => {
        calls.push('delete-track');
        exists = false;
        throw new Error('database response lost');
    };

    const result = await deleteAudioObjectAndTrack(trackId, dependencies);

    assert.equal(result.cleanupPending, false);
    assert.equal(exists, false);
    assert.ok(calls.indexOf('delete-track') < calls.indexOf('finalize-cover-art-deletion'));
});

test('Soundtrack deletion retains lifecycle evidence when the stored S3 key is missing or invalid', async () => {
    for (const s3Key of [
        undefined,
        '   ',
        'images/shared-cover-art',
        'avatars/private-avatar',
        '507f1f77bcf86cd799439099',
        'audio/507f1f77bcf86cd799439099/507f1f77bcf86cd799439012'
    ]) {
        const calls: string[] = [];
        const updates: Array<Record<string, unknown>> = [];
        const dependencies = deletionDependencies(calls, updates);
        dependencies.findTrack = async () => ({ coverArtId: 'cover-art-id', s3Key });

        await assert.rejects(
            deleteAudioObjectAndTrack(trackId, dependencies),
            /storage key is missing or invalid/
        );

        assert.deepEqual(calls, ['update:deleteFailed']);
        assert.equal(updates.at(-1)?.uploadStatus, 'deleteFailed');
        assert.equal(
            updates.at(-1)?.uploadError,
            'Audio track storage key is missing or invalid.'
        );
    }
});

test('Soundtrack deletion stops before object cleanup when cover-art evidence is missing', async () => {
    const calls: string[] = [];
    const updates: Array<Record<string, unknown>> = [];
    const dependencies = deletionDependencies(calls, updates);
    dependencies.prepareTrackCoverArtDeletion = async () => {
        calls.push('prepare-cover-art-deletion');
        return false;
    };

    await assert.rejects(
        deleteAudioObjectAndTrack(trackId, dependencies),
        /Cover-art lifecycle evidence is missing/
    );

    assert.deepEqual(calls, [
        'update:deleting',
        'prepare-cover-art-deletion',
        'update:deleteFailed'
    ]);
    assert.equal(updates.at(-1)?.uploadStatus, 'deleteFailed');
    assert.equal(
        updates.at(-1)?.uploadError,
        'Cover-art lifecycle evidence is missing.'
    );
});

test('Soundtrack deletion performs no cleanup when its lifecycle fence loses the race', async () => {
    const calls: string[] = [];
    const updates: Array<Record<string, unknown>> = [];
    const dependencies = deletionDependencies(calls, updates);
    dependencies.beginDeletion = async () => {
        calls.push('begin-deletion-conflict');
        return { matchedCount: 0 };
    };

    await assert.rejects(
        deleteAudioObjectAndTrack(trackId, dependencies),
        /changed before deletion could be fenced/
    );

    assert.deepEqual(calls, ['begin-deletion-conflict']);
    assert.deepEqual(updates, []);
});

test('audio object keys bind legacy and versioned storage to one Soundtrack identity', () => {
    assert.equal(isAudioObjectKeyForTrack(originalKey, trackId), true);
    assert.equal(isAudioObjectKeyForTrack(replacementKey, trackId), true);
    assert.equal(isAudioObjectKeyForTrack('not-an-id', 'not-an-id'), false);
    assert.equal(isAudioObjectKeyForTrack('507f1f77bcf86cd799439099', trackId), false);
    assert.equal(
        isAudioObjectKeyForTrack('audio/507f1f77bcf86cd799439099/507f1f77bcf86cd799439012', trackId),
        false
    );
});

const uploadFile = {
    fieldname: 'audioFile',
    originalname: 'replacement.mp3',
    encoding: '7bit',
    mimetype: 'audio/mpeg',
    size: 3,
    buffer: Buffer.from('new')
} as Express.Multer.File;

test('audio upload cannot cross a deletion fence', async () => {
    for (const uploadStatus of ['deleting', 'deleteFailed']) {
        const calls: string[] = [];
        const dependencies: AudioUploadDependencies = {
            findTrack: async () => ({ s3Key: originalKey, uploadStatus }),
            createObjectKey: () => replacementKey,
            updateTrackWhere: async () => {
                calls.push('update');
                return { matchedCount: 1 };
            },
            putObject: async () => { calls.push('put'); },
            deleteObject: async () => { calls.push('delete'); }
        };

        await assert.rejects(
            uploadAudioObject(trackId, uploadFile, 'owner', undefined, dependencies),
            /cannot be uploaded while deletion is pending/
        );
        assert.deepEqual(calls, []);
    }
});

test('audio upload retries recorded failed-object cleanup before reserving a replacement', async () => {
    const deletedKeys: string[] = [];
    let state: any = {
        s3Key: replacementKey,
        uploadStatus: 'ready',
        pendingS3Key: stalePendingKey,
        pendingUploadStatus: 'failed',
        storageCleanupS3Key: originalKey,
        storageCleanupStatus: 'deleteFailed'
    };
    const dependencies: AudioUploadDependencies = {
        findTrack: async () => ({ ...state }),
        createObjectKey: () => nextReplacementKey,
        updateTrackWhere: async (_id, expected, update) => {
            const matches = Object.entries(expected).every(([field, value]) => {
                return value === null ? state[field] == null : state[field] === value;
            });
            if (!matches) return { matchedCount: 0 };
            state = { ...state, ...update };
            return { matchedCount: 1 };
        },
        putObject: async () => undefined,
        deleteObject: async key => { deletedKeys.push(key); }
    };

    const result = await uploadAudioObject(trackId, uploadFile, 'owner', undefined, dependencies);

    assert.equal(result.cleanupPending, false);
    assert.equal(state.s3Key, nextReplacementKey);
    assert.equal(state.pendingS3Key, null);
    assert.equal(state.storageCleanupS3Key, null);
    assert.deepEqual(deletedKeys, [stalePendingKey, originalKey, replacementKey]);
});

test('audio replacement uploads a versioned key, attaches it, then deletes the previous object', async () => {
    const calls: string[] = [];
    let state: any = { s3Key: originalKey, uploadStatus: 'ready' };
    const dependencies: AudioUploadDependencies = {
        findTrack: async () => ({ ...state }),
        createObjectKey: () => replacementKey,
        updateTrackWhere: async (_id, expected, update) => {
            const matches = Object.entries(expected).every(([field, value]) => {
                return value === null ? state[field] == null : state[field] === value;
            });
            if (!matches) return { matchedCount: 0 };
            calls.push(`update:${String(update.pendingUploadStatus ?? update.uploadStatus ?? update.storageCleanupStatus)}`);
            state = { ...state, ...update };
            return { matchedCount: 1 };
        },
        putObject: async key => { calls.push(`put:${key}`); },
        deleteObject: async key => { calls.push(`delete:${key}`); }
    };

    const result = await uploadAudioObject(trackId, uploadFile, 'owner', undefined, dependencies);

    assert.equal(result.cleanupPending, false);
    assert.equal(state.s3Key, replacementKey);
    assert.equal(state.uploadStatus, 'ready');
    assert.deepEqual(calls, [
        'update:pending',
        `put:${replacementKey}`,
        'update:ready',
        `delete:${originalKey}`,
        'update:null'
    ]);
});

test('audio replacement checks final attachment and removes an unattached uploaded object', async () => {
    const deletedKeys: string[] = [];
    let state: any = { s3Key: originalKey, uploadStatus: 'ready' };
    let updateCount = 0;
    const dependencies: AudioUploadDependencies = {
        findTrack: async () => ({ ...state }),
        createObjectKey: () => replacementKey,
        updateTrackWhere: async (_id, expected, update) => {
            updateCount += 1;
            if (updateCount === 1) {
                state = { ...state, ...update };
                return { matchedCount: 1 };
            }
            if (updateCount === 2) return { matchedCount: 0 };
            state = { ...state, ...update };
            return { matchedCount: 1 };
        },
        putObject: async () => undefined,
        deleteObject: async key => { deletedKeys.push(key); }
    };

    await assert.rejects(
        uploadAudioObject(trackId, uploadFile, 'owner', undefined, dependencies),
        /could not be finalized/
    );
    assert.deepEqual(deletedKeys, [replacementKey]);
    assert.equal(state.s3Key, originalKey);
});

test('audio upload failures report whether replacement-object cleanup is pending', async () => {
    for (const cleanupFails of [false, true]) {
        let state: any = { s3Key: originalKey, uploadStatus: 'ready' };
        const dependencies: AudioUploadDependencies = {
            findTrack: async () => ({ ...state }),
            createObjectKey: () => replacementKey,
            updateTrackWhere: async (_id, expected, update) => {
                const matches = Object.entries(expected).every(([field, value]) =>
                    value === null ? state[field] == null : state[field] === value
                );
                if (!matches) return { matchedCount: 0 };
                state = { ...state, ...update };
                return { matchedCount: 1 };
            },
            putObject: async () => { throw new Error('simulated put failure'); },
            deleteObject: async () => {
                if (cleanupFails) throw new Error('simulated cleanup failure');
            }
        };

        await assert.rejects(
            uploadAudioObject(trackId, uploadFile, 'owner', undefined, dependencies),
            (error: any) => error?.code === 'audio_upload_failed'
                && error?.cleanupPending === cleanupFails
        );
    }
});

test('audio attachment preserves reconciliation evidence when confirmation is unavailable', async () => {
    let state: any = { s3Key: originalKey, uploadStatus: 'ready' };
    let updateCount = 0;
    const dependencies: AudioUploadDependencies = {
        findTrack: async () => {
            if (updateCount >= 2) throw new Error('confirmation unavailable');
            return { ...state };
        },
        createObjectKey: () => replacementKey,
        updateTrackWhere: async (_id, _expected, update) => {
            updateCount += 1;
            if (updateCount === 2) throw new Error('database response lost');
            state = { ...state, ...update };
            return { matchedCount: 1 };
        },
        putObject: async () => undefined,
        deleteObject: async () => undefined
    };

    await assert.rejects(
        uploadAudioObject(trackId, uploadFile, 'owner', undefined, dependencies),
        (error: any) => error?.code === 'audio_upload_outcome_unknown'
            && error?.cleanupPending === true
            && error?.outcomeUnknown === true
    );
    assert.equal(state.pendingS3Key, replacementKey);
});

test('audio replacement keeps a committed attachment when the final database response is uncertain', async () => {
    const deletedKeys: string[] = [];
    let state: any = { s3Key: originalKey, uploadStatus: 'ready' };
    let updateCount = 0;
    const dependencies: AudioUploadDependencies = {
        findTrack: async () => ({ ...state }),
        createObjectKey: () => replacementKey,
        updateTrackWhere: async (_id, _expected, update) => {
            updateCount += 1;
            state = { ...state, ...update };
            if (updateCount === 2) throw new Error('database response lost');
            return { matchedCount: 1 };
        },
        putObject: async () => undefined,
        deleteObject: async key => { deletedKeys.push(key); }
    };

    const result = await uploadAudioObject(trackId, uploadFile, 'owner', undefined, dependencies);

    assert.equal(result.cleanupPending, false);
    assert.equal(state.s3Key, replacementKey);
    assert.deepEqual(deletedKeys, [originalKey]);
});

test('audio replacement does not clear cleanup evidence after a delete fence wins', async () => {
    let state: any = { s3Key: originalKey, uploadStatus: 'ready' };
    const dependencies: AudioUploadDependencies = {
        findTrack: async () => ({ ...state }),
        createObjectKey: () => replacementKey,
        updateTrackWhere: async (_id, expected, update) => {
            const matches = Object.entries(expected).every(([field, value]) => {
                return value === null ? state[field] == null : state[field] === value;
            });
            if (!matches) return { matchedCount: 0 };
            state = { ...state, ...update };
            return { matchedCount: 1 };
        },
        putObject: async () => undefined,
        deleteObject: async key => {
            if (key === originalKey) state.uploadStatus = 'deleting';
        }
    };

    const result = await uploadAudioObject(trackId, uploadFile, 'owner', undefined, dependencies);

    assert.equal(result.cleanupPending, true);
    assert.equal(state.uploadStatus, 'deleting');
    assert.equal(state.storageCleanupS3Key, originalKey);
});
