import assert from 'node:assert/strict';
import test from 'node:test';
import { ObjectId } from 'mongodb';

import {
    attachCoverArtToNewOwner,
    CoverArtDeletionDependencies,
    deleteCoverArt,
    deleteCoverArtOwner,
    finalizeStagedCoverArtLifecycleRecord,
    finalizeOwnerCoverArtDeletions,
    prepareOwnerCoverArtDeletions,
    updateCoverArtOwnerAndCleanup
} from '../src/services/imageStorageService';

const imageId = '507f1f77bcf86cd799439011';
const replacementImageId = '507f1f77bcf86cd799439012';
const winningImageId = '507f1f77bcf86cd799439013';
const ownerId = '507f1f77bcf86cd799439099';
const lostMongoResponse = () => Object.assign(
    new Error('database response lost'),
    { name: 'MongoNetworkError' }
);

const pendingAsset = () => ({
    _id: ObjectId.createFromHexString(imageId),
    ownerType: 'album' as const,
    ownerId,
    createdBy: '507f1f77bcf86cd799439098',
    originalFileName: 'cover.jpg',
    contentType: 'image/jpeg',
    s3Key: `images/${imageId}`,
    uploadStatus: 'pending' as const,
    uploadUpdatedAt: new Date(),
    uploadError: null
});

test('cover upload finalization wins before deletion and deletion observes ready evidence', async () => {
    const staged = pendingAsset();
    let record: any = { ...staged };
    const calls: string[] = [];

    await finalizeStagedCoverArtLifecycleRecord(staged, {}, {
        runWithOwnerFence: async (_asset, _options, mutation) => {
            calls.push('touch-ready-owner');
            return mutation();
        },
        updatePendingAsset: async (_asset, update) => {
            assert.equal(record.uploadStatus, 'pending');
            Object.assign(record, update);
            calls.push('publish-ready');
            return { matchedCount: 1 };
        },
        findAsset: async () => record
    });

    await deleteCoverArt(imageId, {
        findAsset: async () => record,
        updateAsset: async (_id, update, expected) => {
            assert.equal(expected?.uploadStatus, 'ready');
            Object.assign(record, update);
            calls.push('prepare-delete');
            return { matchedCount: 1 };
        },
        deleteObject: async () => { calls.push('delete-object'); },
        deleteAsset: async () => {
            record = null;
            calls.push('delete-evidence');
            return { deletedCount: 1 };
        }
    });

    assert.deepEqual(calls, [
        'touch-ready-owner',
        'publish-ready',
        'prepare-delete',
        'delete-object',
        'delete-evidence'
    ]);
});

test('deletion first retains a pending upload and blocks owner-fenced finalization', async () => {
    const staged = pendingAsset();
    let storageDeletes = 0;
    let stateUpdates = 0;
    await assert.rejects(
        deleteCoverArt(imageId, {
            findAsset: async () => staged,
            updateAsset: async () => { stateUpdates += 1; },
            deleteObject: async () => { storageDeletes += 1; },
            deleteAsset: async () => undefined
        }),
        (error: any) => error?.code === 'cover_art_upload_in_progress'
    );
    assert.equal(storageDeletes, 0);
    assert.equal(stateUpdates, 0);

    await assert.rejects(
        finalizeStagedCoverArtLifecycleRecord(staged, {}, {
            runWithOwnerFence: async () => {
                throw Object.assign(new Error('Album unavailable'), {
                    code: 'album_reference_unavailable'
                });
            },
            updatePendingAsset: async () => ({ matchedCount: 0 }),
            findAsset: async () => staged
        }),
        (error: any) => error?.code === 'album_reference_unavailable'
    );
});

test('lost finalization response confirms the exact committed ready lifecycle record', async () => {
    const staged = pendingAsset();
    let record: any = { ...staged };
    await finalizeStagedCoverArtLifecycleRecord(staged, {}, {
        runWithOwnerFence: async (_asset, _options, mutation) => {
            await mutation();
            throw Object.assign(new Error('commit response lost'), {
                hasErrorLabel: (label: string) => label === 'UnknownTransactionCommitResult'
            });
        },
        updatePendingAsset: async (_asset, update) => {
            Object.assign(record, update);
            return { matchedCount: 1 };
        },
        findAsset: async () => record
    });
    assert.equal(record.uploadStatus, 'ready');
});

test('missing lifecycle evidence never authorizes a guessed cover-art deletion', async () => {
    let storageDeletes = 0;
    let recordDeletes = 0;
    await deleteCoverArt(imageId, {
        findAsset: async () => null,
        updateAsset: async () => undefined,
        deleteObject: async () => { storageDeletes += 1; },
        deleteAsset: async () => { recordDeletes += 1; }
    });

    assert.equal(storageDeletes, 0);
    assert.equal(recordDeletes, 0);
});

test('failed cover-art deletion retains the recorded key and retries deterministically', async () => {
    const updates: Array<Record<string, unknown>> = [];
    const deletedKeys: string[] = [];
    let asset: any = {
        ownerType: 'album',
        ownerId: 'album-id',
        s3Key: `images/${imageId}`,
        uploadStatus: 'ready'
    };
    let attempts = 0;
    const dependencies: CoverArtDeletionDependencies = {
        findAsset: async () => asset,
        updateAsset: async (_id, update) => {
            updates.push(update);
            Object.assign(asset, update);
        },
        deleteObject: async (s3Key) => {
            attempts += 1;
            deletedKeys.push(s3Key);
            if (attempts === 1) throw new Error('simulated storage interruption');
        },
        deleteAsset: async () => { asset = null; }
    };

    await assert.rejects(
        deleteCoverArt(imageId, dependencies),
        /simulated storage interruption/
    );
    assert.equal(asset.uploadStatus, 'deleteFailed');
    assert.equal(asset.uploadError, 'simulated storage interruption');
    assert.equal(updates.at(-1)?.uploadStatus, 'deleteFailed');

    await deleteCoverArt(imageId, dependencies);
    assert.deepEqual(deletedKeys, [
        `images/${imageId}`,
        `images/${imageId}`
    ]);
    assert.equal(asset, null);
});

test('cover-art cleanup refuses an asset recorded for a different owner', async () => {
    const updates: Array<Record<string, unknown>> = [];
    let storageDeletes = 0;
    await assert.rejects(
        deleteCoverArt(imageId, {
            expectedOwnerType: 'album',
            expectedOwnerId: 'album-one',
            findAsset: async () => ({
                ownerType: 'album',
                ownerId: 'album-two',
                s3Key: `images/${imageId}`
            }),
            updateAsset: async (_id, update) => { updates.push(update); },
            deleteObject: async () => { storageDeletes += 1; },
            deleteAsset: async () => undefined
        }),
        /storage key is missing or invalid/
    );
    assert.equal(storageDeletes, 0);
    assert.deepEqual(updates, []);
});

test('cover-art cleanup rejects a same-namespace key bound to another image identity', async () => {
    let storageDeletes = 0;
    await assert.rejects(
        deleteCoverArt(imageId, {
            expectedOwnerType: 'album',
            expectedOwnerId: 'album-one',
            findAsset: async () => ({
                ownerType: 'album',
                ownerId: 'album-one',
                s3Key: 'images/507f1f77bcf86cd799439012'
            }),
            updateAsset: async () => undefined,
            deleteObject: async () => { storageDeletes += 1; },
            deleteAsset: async () => undefined
        }),
        /storage key is missing or invalid/
    );
    assert.equal(storageDeletes, 0);
});

test('owner deletion prepares and finalizes current and detached artwork records', async () => {
    const assets = new Map<string, any>([
        [imageId, {
            _id: imageId,
            ownerType: 'album',
            ownerId,
            s3Key: `images/${imageId}`,
            uploadStatus: 'ready'
        }],
        [replacementImageId, {
            _id: replacementImageId,
            ownerType: 'album',
            ownerId,
            s3Key: `images/${replacementImageId}`,
            uploadStatus: 'deleteFailed'
        }]
    ]);
    const deletedObjects: string[] = [];
    const dependencies = {
        findAssets: async () => [...assets.values()],
        findAsset: async (id: string) => assets.get(id) ?? null,
        updateAsset: async (id: string, update: Record<string, unknown>) => {
            Object.assign(assets.get(id), update);
            return { matchedCount: 1 };
        },
        deleteObject: async (key: string) => { deletedObjects.push(key); },
        deleteAsset: async (id: string) => {
            const deleted = assets.delete(id);
            return { deletedCount: deleted ? 1 : 0 };
        }
    };

    const prepared = await prepareOwnerCoverArtDeletions(
        'album',
        ownerId,
        replacementImageId,
        dependencies
    );
    assert.deepEqual(prepared, [imageId, replacementImageId]);
    assert.deepEqual(deletedObjects, [
        `images/${imageId}`,
        `images/${replacementImageId}`
    ]);

    await finalizeOwnerCoverArtDeletions(prepared, dependencies);
    assert.equal(assets.size, 0);
});

test('missing previous lifecycle evidence retains the owner reference and reports pending cleanup', async () => {
    let ownerUpdates = 0;
    const result = await updateCoverArtOwnerAndCleanup(
        'album-id',
        { coverArtId: null },
        imageId,
        true,
        {
            ownerType: 'album',
            verifyPreviousAsset: async () => false,
            updateOwner: async () => { ownerUpdates += 1; }
        }
    );

    assert.equal(result.cleanupPending, true);
    assert.equal(result.updateApplied, false);
    assert.equal(ownerUpdates, 0);
});

test('missing previous evidence safely removes a replacement that was never attached', async () => {
    const deletedReplacements: string[] = [];
    const result = await updateCoverArtOwnerAndCleanup(
        ownerId,
        { coverArtId: replacementImageId },
        imageId,
        true,
        {
            ownerType: 'album',
            verifyPreviousAsset: async () => false,
            updateOwner: async () => ({ matchedCount: 1 }),
            deleteReplacementAsset: async id => { deletedReplacements.push(id); }
        }
    );

    assert.equal(result.updateApplied, false);
    assert.equal(result.cleanupPending, true);
    assert.equal(result.replacementCleanupPending, false);
    assert.deepEqual(deletedReplacements, [replacementImageId]);
});

test('a losing concurrent cover replacement cleans only its unattached new asset', async () => {
    const deletedReplacements: string[] = [];
    const result = await updateCoverArtOwnerAndCleanup(
        ownerId,
        { coverArtId: replacementImageId },
        imageId,
        true,
        {
            ownerType: 'album',
            verifyPreviousAsset: async () => true,
            updateOwner: async () => ({ matchedCount: 1 }),
            updateOwnerIfCoverArtMatches: async () => ({ matchedCount: 0 }),
            findOwner: async () => ({ coverArtId: winningImageId }),
            deleteReplacementAsset: async id => { deletedReplacements.push(id); }
        }
    );

    assert.equal(result.updateApplied, false);
    assert.equal(result.cleanupPending, false);
    assert.deepEqual(deletedReplacements, [replacementImageId]);
});

test('a committed cover attachment survives a lost database response', async () => {
    const deletedOldAssets: string[] = [];
    const result = await updateCoverArtOwnerAndCleanup(
        ownerId,
        { coverArtId: replacementImageId },
        imageId,
        true,
        {
            ownerType: 'album',
            verifyPreviousAsset: async () => true,
            updateOwner: async () => ({ matchedCount: 1 }),
            updateOwnerIfCoverArtMatches: async () => {
                throw lostMongoResponse();
            },
            findOwner: async () => ({ coverArtId: replacementImageId }),
            deleteAsset: async id => { deletedOldAssets.push(id); }
        }
    );

    assert.equal(result.updateApplied, true);
    assert.equal(result.cleanupPending, false);
    assert.deepEqual(deletedOldAssets, [imageId]);
});

test('an indeterminate cover attachment preserves the replacement lifecycle record', async () => {
    const deletedReplacements: string[] = [];
    const result = await updateCoverArtOwnerAndCleanup(
        ownerId,
        { coverArtId: replacementImageId },
        imageId,
        true,
        {
            ownerType: 'album',
            verifyPreviousAsset: async () => true,
            updateOwner: async () => ({ matchedCount: 1 }),
            updateOwnerIfCoverArtMatches: async () => {
                throw lostMongoResponse();
            },
            findOwner: async () => {
                throw new Error('confirmation unavailable');
            },
            deleteReplacementAsset: async id => { deletedReplacements.push(id); }
        }
    );

    assert.equal(result.updateApplied, false);
    assert.equal(result.cleanupPending, true);
    assert.equal(result.replacementCleanupPending, true);
    assert.deepEqual(deletedReplacements, []);
});

test('new-owner cover attachment cleans an image after a definite CAS loss', async () => {
    const deleted: string[] = [];
    await assert.rejects(
        attachCoverArtToNewOwner(
            ownerId,
            { imageId: replacementImageId, coverArtUrl: `/content/image/${replacementImageId}` },
            {
                ownerType: 'album',
                updateOwner: async () => ({ matchedCount: 0 }),
                updateOwnerIfCoverArtMatches: async () => ({ matchedCount: 0 }),
                findOwner: async () => null,
                deleteReplacementAsset: async id => { deleted.push(id); }
            }
        ),
        (error: any) => error?.code === 'cover_art_attachment_conflict'
            && error?.cleanupPending === false
    );
    assert.deepEqual(deleted, [replacementImageId]);
});

test('new-owner cover attachment confirms a committed write after its response is lost', async () => {
    const result = await attachCoverArtToNewOwner(
        ownerId,
        { imageId: replacementImageId, coverArtUrl: `/content/image/${replacementImageId}` },
        {
            ownerType: 'artist',
            updateOwner: async () => ({ matchedCount: 0 }),
            updateOwnerIfCoverArtMatches: async () => {
                throw lostMongoResponse();
            },
            findOwner: async () => ({
                coverArtId: replacementImageId,
                coverArtUrl: `/content/image/${replacementImageId}`
            })
        }
    );
    assert.equal(result.updateApplied, true);
    assert.equal(result.cleanupPending, false);
});

test('new-owner cover attachment preserves evidence when confirmation is unavailable', async () => {
    const deleted: string[] = [];
    await assert.rejects(
        attachCoverArtToNewOwner(
            ownerId,
            { imageId: replacementImageId, coverArtUrl: `/content/image/${replacementImageId}` },
            {
                ownerType: 'audioTrack',
                updateOwner: async () => ({ matchedCount: 0 }),
                updateOwnerIfCoverArtMatches: async () => {
                    throw lostMongoResponse();
                },
                findOwner: async () => { throw new Error('confirmation unavailable'); },
                deleteReplacementAsset: async id => { deleted.push(id); }
            }
        ),
        (error: any) => error?.code === 'cover_art_attachment_outcome_unknown'
            && error?.cleanupPending === true
    );
    assert.deepEqual(deleted, []);
});

test('missing lifecycle evidence retains an entity instead of claiming successful deletion', async () => {
    let ownerDeletes = 0;
    const result = await deleteCoverArtOwner(
        'album',
        'album-id',
        imageId,
        async () => { ownerDeletes += 1; },
        { prepareAssetDeletion: async () => false }
    );

    assert.equal(result.cleanupPending, true);
    assert.equal(result.ownerDeleted, false);
    assert.equal(ownerDeletes, 0);
});

test('cover-art removal detaches the owner before cleanup and reports partial failure', async () => {
    const calls: string[] = [];
    const first = await updateCoverArtOwnerAndCleanup(
        'album-id',
        { coverArtId: null, coverArtUrl: '' },
        imageId,
        true,
        {
            ownerType: 'album',
            updateOwner: async () => { calls.push('detach-owner'); },
            deleteAsset: async () => {
                calls.push('delete-asset');
                throw new Error('cleanup failed');
            }
        }
    );

    assert.deepEqual(calls, ['detach-owner', 'delete-asset']);
    assert.equal(first.cleanupPending, true);
    assert.match(String(first.cleanupError), /cleanup failed/);

    const retryCalls: string[] = [];
    const retry = await updateCoverArtOwnerAndCleanup(
        'album-id',
        { coverArtId: null, coverArtUrl: '' },
        imageId,
        true,
        {
            ownerType: 'album',
            updateOwner: async () => { retryCalls.push('detach-owner'); },
            deleteAsset: async () => { retryCalls.push('delete-asset'); }
        }
    );
    assert.deepEqual(retryCalls, ['detach-owner', 'delete-asset']);
    assert.equal(retry.cleanupPending, false);
});

test('entity deletion retains image lifecycle evidence until the owner is gone', async () => {
    const calls: string[] = [];
    const result = await deleteCoverArtOwner(
        'album',
        'album-id',
        imageId,
        async () => { calls.push('delete-owner'); },
        {
            prepareAssetDeletion: async () => {
                calls.push('delete-storage-object');
                return true;
            },
            finalizeAssetDeletion: async () => {
                calls.push('delete-lifecycle-record');
                throw new Error('database finalization interrupted');
            }
        }
    );

    assert.deepEqual(calls, [
        'delete-storage-object',
        'delete-owner',
        'delete-lifecycle-record'
    ]);
    assert.equal(result.cleanupPending, true);
});

test('entity deletion does not remove its owner when storage deletion fails', async () => {
    let ownerDeletes = 0;
    const result = await deleteCoverArtOwner(
        'album',
        'album-id',
        imageId,
        async () => { ownerDeletes += 1; },
        {
            prepareAssetDeletion: async () => {
                throw new Error('storage unavailable');
            }
        }
    );
    assert.equal(ownerDeletes, 0);
    assert.equal(result.ownerDeleted, false);
    assert.equal(result.cleanupPending, true);
    assert.match(String(result.cleanupError), /storage unavailable/);
});

test('entity deletion keeps the lifecycle record when owner finalization fails', async () => {
    const calls: string[] = [];
    await assert.rejects(
        deleteCoverArtOwner(
            'album',
            'album-id',
            imageId,
            async () => {
                calls.push('delete-owner');
                throw new Error('owner cleanup interrupted');
            },
            {
                prepareAssetDeletion: async () => {
                    calls.push('delete-storage-object');
                    return true;
                },
                finalizeAssetDeletion: async () => {
                    calls.push('delete-lifecycle-record');
                }
            }
        ),
        /owner cleanup interrupted/
    );
    assert.deepEqual(calls, ['delete-storage-object', 'delete-owner']);
});
