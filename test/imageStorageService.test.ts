import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import sharp from 'sharp';

import {
    coverArtVariantEtag,
    coverArtVariantWidths,
    deleteCoverArt,
    finalizeStagedCoverArtLifecycleRecord,
    getCoverArtObject,
    getCoverArtVariant,
    isCoverArtVariantWidth,
    isPublicCoverArtAsset,
    markStagedCoverArtUploadFailed,
    resolvePublicCoverArtAsset,
    stageCoverArtLifecycleRecord,
    transformCoverArtVariant,
    updateCoverArtOwnerAndCleanup,
    uploadCoverArt,
    validateCoverArtFile
} from '../src/services/imageStorageService';

const imageId = '507f1f77bcf86cd799439011';
const readyAsset = (ownerType: 'artist' | 'album' | 'audioTrack' | 'user') => ({
    ownerType,
    ownerId: '507f191e810c19729de860ea',
    uploadStatus: 'ready' as const,
    s3Key: `images/${imageId}`,
    contentType: 'image/jpeg'
});
const attachedOwner = {
    coverArtId: imageId,
    lifecycleStatus: 'ready',
    uploadStatus: 'ready',
    s3Key: '507f191e810c19729de860ea'
};
const uploadedFile = (buffer: Buffer, mimetype: string): Express.Multer.File => ({
    fieldname: 'coverArtFile',
    originalname: 'cover-art',
    encoding: '7bit',
    mimetype,
    size: buffer.length,
    stream: Readable.from(buffer),
    destination: '',
    filename: '',
    path: '',
    buffer
});

test('an unknown relationship transaction preserves both previous and replacement artwork', async () => {
    const previousImageId = '507f1f77bcf86cd799439012';
    const replacementImageId = '507f1f77bcf86cd799439013';
    let ownerReadCalls = 0;
    let previousDeleteCalls = 0;
    let replacementDeleteCalls = 0;
    const result = await updateCoverArtOwnerAndCleanup(
        '507f191e810c19729de860ea',
        { coverArtId: replacementImageId },
        previousImageId,
        true,
        {
            ownerType: 'album',
            verifyPreviousAsset: async () => true,
            updateOwner: async () => ({ matchedCount: 1 }),
            updateOwnerIfCoverArtMatches: async () => {
                throw Object.assign(new Error('commit reply lost'), { outcomeUnknown: true });
            },
            findOwner: async () => {
                ownerReadCalls += 1;
                return { coverArtId: replacementImageId };
            },
            deleteAsset: async () => { previousDeleteCalls += 1; },
            deleteReplacementAsset: async () => { replacementDeleteCalls += 1; }
        }
    );

    assert.equal(result.updateApplied, false);
    assert.equal(result.cleanupPending, true);
    assert.equal(result.outcomeUnknown, true);
    assert.equal(result.replacementCleanupPending, true);
    assert.equal(ownerReadCalls, 0);
    assert.equal(previousDeleteCalls, 0);
    assert.equal(replacementDeleteCalls, 0);
});

test('a definite combined-owner failure is not inferred successful from an unchanged empty cover', async () => {
    let ownerReadCalls = 0;
    const result = await updateCoverArtOwnerAndCleanup(
        '507f191e810c19729de860ea',
        { coverArtId: null, artistIds: ['507f1f77bcf86cd799439014'] },
        null,
        true,
        {
            ownerType: 'audioTrack',
            updateOwner: async () => ({ matchedCount: 1 }),
            updateOwnerIfCoverArtMatches: async () => {
                throw Object.assign(new Error('Artist is deleting'), {
                    code: 'artist_reference_unavailable'
                });
            },
            findOwner: async () => {
                ownerReadCalls += 1;
                return { coverArtId: null };
            }
        }
    );

    assert.equal(result.updateApplied, false);
    assert.equal(result.cleanupPending, false);
    assert.equal(ownerReadCalls, 0);
});

test('a zero-match concurrent remove is a conflict and never deletes the prior asset', async () => {
    let ownerReadCalls = 0;
    let previousDeleteCalls = 0;
    const result = await updateCoverArtOwnerAndCleanup(
        '507f191e810c19729de860ea',
        { coverArtId: null, title: 'Requested title' },
        '507f1f77bcf86cd799439012',
        true,
        {
            ownerType: 'album',
            verifyPreviousAsset: async () => true,
            updateOwner: async () => ({ matchedCount: 1 }),
            updateOwnerIfCoverArtMatches: async () => ({ matchedCount: 0 }),
            findOwner: async () => {
                ownerReadCalls += 1;
                return { coverArtId: null, title: 'Concurrent title' };
            },
            deleteAsset: async () => { previousDeleteCalls += 1; }
        }
    );

    assert.equal(result.updateApplied, false);
    assert.equal(result.cleanupPending, false);
    assert.equal(ownerReadCalls, 0);
    assert.equal(previousDeleteCalls, 0);
});

test('a possible lost write response requires an exact full-owner readback', async () => {
    const previousImageId = '507f1f77bcf86cd799439012';
    const replacementImageId = '507f1f77bcf86cd799439013';
    const networkError = Object.assign(new Error('response lost'), {
        name: 'MongoNetworkError'
    });
    let previousDeleteCalls = 0;
    const exact = await updateCoverArtOwnerAndCleanup(
        '507f191e810c19729de860ea',
        { coverArtId: replacementImageId, title: 'Exact title' },
        previousImageId,
        true,
        {
            ownerType: 'album',
            verifyPreviousAsset: async () => true,
            updateOwner: async () => ({ matchedCount: 1 }),
            updateOwnerIfCoverArtMatches: async () => { throw networkError; },
            findOwner: async () => ({
                coverArtId: replacementImageId,
                title: 'Exact title'
            }),
            deleteAsset: async () => { previousDeleteCalls += 1; }
        }
    );
    assert.equal(exact.updateApplied, true);
    assert.equal(exact.cleanupPending, false);
    assert.equal(previousDeleteCalls, 1);

    let replacementDeleteCalls = 0;
    const partial = await updateCoverArtOwnerAndCleanup(
        '507f191e810c19729de860ea',
        { coverArtId: replacementImageId, title: 'Requested title' },
        previousImageId,
        true,
        {
            ownerType: 'album',
            verifyPreviousAsset: async () => true,
            updateOwner: async () => ({ matchedCount: 1 }),
            updateOwnerIfCoverArtMatches: async () => { throw networkError; },
            findOwner: async () => ({
                coverArtId: replacementImageId,
                title: 'Concurrent title'
            }),
            deleteAsset: async () => { previousDeleteCalls += 1; },
            deleteReplacementAsset: async () => { replacementDeleteCalls += 1; }
        }
    );
    assert.equal(partial.updateApplied, false);
    assert.equal(partial.outcomeUnknown, true);
    assert.equal(partial.cleanupPending, true);
    assert.equal(previousDeleteCalls, 1);
    assert.equal(replacementDeleteCalls, 0);
});

const exactMatches = (record: Record<string, any>, expected: Record<string, any>) =>
    Object.entries(expected).every(([key, value]) => {
        if (value && typeof value === 'object' && '$exists' in value) {
            return Object.prototype.hasOwnProperty.call(record, key) === Boolean(value.$exists);
        }
        return record[key] === value;
    });

const validCoverFile = async () => uploadedFile(await sharp({
    create: { width: 12, height: 12, channels: 3, background: '#31598a' }
}).png().toBuffer(), 'image/png');

const unknownCommitError = () => Object.assign(new Error('commit response lost'), {
    hasErrorLabel: (label: string) => label === 'UnknownTransactionCommitResult'
});

test('upload orchestrator continues only after an exact pending staging readback', async () => {
    const file = await validCoverFile();
    let record: any;
    let putCalls = 0;
    const result = await uploadCoverArt(
        'album',
        '507f191e810c19729de860ea',
        file,
        '507f191e810c19729de860eb',
        {},
        {
            stageAsset: (asset, options) => stageCoverArtLifecycleRecord(
                asset,
                options,
                {
                    runWithOwnerFence: async (_asset, _options, mutation) => {
                        await mutation();
                        throw unknownCommitError();
                    },
                    insertAsset: async (assetToInsert) => { record = { ...assetToInsert }; },
                    findAsset: async () => record
                }
            ),
            putObject: async () => { putCalls += 1; },
            finalizeAsset: async () => { record.uploadStatus = 'ready'; },
            deleteObject: async () => assert.fail('confirmed staging must not clean storage'),
            markFailedAsset: async () => assert.fail('confirmed staging must not fail the row')
        }
    );
    assert.equal(result.imageId, String(record._id));
    assert.equal(record.uploadStatus, 'ready');
    assert.equal(putCalls, 1);
});

test('upload orchestrator does not Put when an unknown staging commit cannot be confirmed', async () => {
    const file = await validCoverFile();
    for (const readback of ['missing', 'unavailable'] as const) {
        let putCalls = 0;
        let cleanupCalls = 0;
        await assert.rejects(
            uploadCoverArt(
                'album',
                '507f191e810c19729de860ea',
                file,
                '507f191e810c19729de860eb',
                {},
                {
                    stageAsset: (asset, options) => stageCoverArtLifecycleRecord(
                        asset,
                        options,
                        {
                            runWithOwnerFence: async () => { throw unknownCommitError(); },
                            insertAsset: async () => undefined,
                            findAsset: async () => {
                                if (readback === 'unavailable') throw new Error('readback failed');
                                return null;
                            }
                        }
                    ),
                    putObject: async () => { putCalls += 1; },
                    finalizeAsset: async () => undefined,
                    deleteObject: async () => { cleanupCalls += 1; },
                    markFailedAsset: async () => { cleanupCalls += 1; }
                }
            ),
            (error: any) => error?.code === 'cover_art_upload_outcome_unknown'
                && error?.cleanupPending === true
                && error?.reconciliationRequired === true
        );
        assert.equal(putCalls, 0);
        assert.equal(cleanupCalls, 0);
    }
});

test('upload orchestrator preserves a definite staging failure when no row could commit', async () => {
    const file = await validCoverFile();
    let putCalls = 0;
    const definiteError = Object.assign(new Error('owner is already deleting'), {
        code: 'album_reference_unavailable'
    });
    await assert.rejects(
        uploadCoverArt(
            'album',
            '507f191e810c19729de860ea',
            file,
            '507f191e810c19729de860eb',
            {},
            {
                stageAsset: (asset, options) => stageCoverArtLifecycleRecord(
                    asset,
                    options,
                    {
                        runWithOwnerFence: async () => { throw definiteError; },
                        insertAsset: async () => undefined,
                        findAsset: async () => assert.fail('definite failure needs no readback')
                    }
                ),
                putObject: async () => { putCalls += 1; },
                finalizeAsset: async () => undefined,
                deleteObject: async () => undefined,
                markFailedAsset: async () => undefined
            }
        ),
        (error: any) => error === definiteError
    );
    assert.equal(putCalls, 0);
});

test('upload orchestrator cleans the exact Put when owner deletion wins and leaves a retryable failed row', async () => {
    const file = await validCoverFile();
    let record: any | null = null;
    const storedKeys = new Set<string>();
    const deletedKeys: string[] = [];
    const conditionalUpdate = async (
        id: string,
        expected: Record<string, unknown>,
        update: Record<string, unknown>
    ) => {
        const matched = record
            && String(record._id) === id
            && exactMatches(record, expected);
        if (matched) Object.assign(record, update);
        return { matchedCount: matched ? 1 : 0 };
    };
    const ownerError = Object.assign(new Error('Album deletion won.'), {
        code: 'album_reference_unavailable'
    });

    await assert.rejects(
        uploadCoverArt(
            'album',
            '507f191e810c19729de860ea',
            file,
            '507f191e810c19729de860eb',
            {},
            {
                stageAsset: async (asset) => { record = { ...asset }; },
                putObject: async (asset) => { storedKeys.add(asset.s3Key); },
                finalizeAsset: async () => { throw ownerError; },
                deleteObject: async (key) => {
                    assert.equal(key, `images/${String(record!._id)}`);
                    deletedKeys.push(key);
                    storedKeys.delete(key);
                },
                markFailedAsset: (asset, error) => markStagedCoverArtUploadFailed(
                    asset,
                    error,
                    conditionalUpdate
                )
            }
        ),
        (error: any) => error?.code === 'album_reference_unavailable'
    );
    assert.equal(record!.uploadStatus, 'failed');
    assert.equal(storedKeys.size, 0);
    assert.deepEqual(deletedKeys, [record!.s3Key]);
    assert.equal(record!.ownerType, 'album');
    assert.equal(record!.ownerId, '507f191e810c19729de860ea');
    assert.equal(record!.createdBy, '507f191e810c19729de860eb');

    for (const protectedStatus of ['ready', 'deleting', 'deleteFailed']) {
        record!.uploadStatus = protectedStatus;
        const before = { ...record };
        const result = await markStagedCoverArtUploadFailed(
            record!,
            new Error('late failure'),
            conditionalUpdate
        );
        assert.equal(result.matchedCount, 0);
        assert.deepEqual(record, before);
    }

    record!.uploadStatus = 'failed';
    const exactKey = record!.s3Key;
    await deleteCoverArt(String(record!._id), {
        expectedOwnerType: 'album',
        expectedOwnerId: record!.ownerId,
        findAsset: async () => record,
        updateAsset: (id, update, expected = {}) => conditionalUpdate(
            id,
            expected,
            update
        ),
        deleteObject: async (key) => { deletedKeys.push(key); },
        deleteAsset: async () => {
            assert.equal(record!.uploadStatus, 'deleting');
            record = null;
            return { deletedCount: 1 };
        }
    });
    assert.equal(record, null);
    assert.deepEqual(deletedKeys, [
        exactKey,
        exactKey
    ]);
});

test('upload orchestrator reports cleanup uncertainty and retains exact lifecycle evidence', async () => {
    const file = await validCoverFile();
    let record: any;
    const storedKeys = new Set<string>();
    const conditionalUpdate = async (
        id: string,
        expected: Record<string, unknown>,
        update: Record<string, unknown>
    ) => {
        const matched = String(record._id) === id && exactMatches(record, expected);
        if (matched) Object.assign(record, update);
        return { matchedCount: matched ? 1 : 0 };
    };

    await assert.rejects(
        uploadCoverArt(
            'album',
            '507f191e810c19729de860ea',
            file,
            '507f191e810c19729de860eb',
            {},
            {
                stageAsset: async (asset) => { record = { ...asset }; },
                putObject: async (asset) => { storedKeys.add(asset.s3Key); },
                finalizeAsset: async () => { throw new Error('owner unavailable'); },
                deleteObject: async () => { throw new Error('delete response lost'); },
                markFailedAsset: (asset, error) => markStagedCoverArtUploadFailed(
                    asset,
                    error,
                    conditionalUpdate
                )
            }
        ),
        (error: any) => error?.statusCode === 503
            && error?.code === 'cover_art_upload_cleanup_pending'
            && error?.cleanupPending === true
            && error?.reconciliationRequired === true
    );
    assert.equal(record.uploadStatus, 'failed');
    assert.equal(record.uploadError, 'delete response lost');
    assert.equal(storedKeys.has(record.s3Key), true);
    assert.equal(record.s3Key, `images/${String(record._id)}`);
});

test('upload orchestrator accepts only an exact ready readback after a lost finalize response', async () => {
    const file = await validCoverFile();
    let record: any;
    let cleanupCalls = 0;
    const result = await uploadCoverArt(
        'album',
        '507f191e810c19729de860ea',
        file,
        '507f191e810c19729de860eb',
        {},
        {
            stageAsset: async (asset) => { record = { ...asset }; },
            putObject: async () => undefined,
            finalizeAsset: (asset, options) => finalizeStagedCoverArtLifecycleRecord(
                asset,
                options,
                {
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
                }
            ),
            deleteObject: async () => { cleanupCalls += 1; },
            markFailedAsset: async () => { cleanupCalls += 1; }
        }
    );
    assert.equal(result.imageId, String(record._id));
    assert.equal(record.uploadStatus, 'ready');
    assert.equal(cleanupCalls, 0);
});

test('upload orchestrator preserves pending evidence when finalize readback is pending or unavailable', async () => {
    const file = await validCoverFile();
    for (const readbackFails of [false, true]) {
        let record: any;
        let deleteCalls = 0;
        let failedUpdates = 0;
        await assert.rejects(
            uploadCoverArt(
                'album',
                '507f191e810c19729de860ea',
                file,
                '507f191e810c19729de860eb',
                {},
                {
                    stageAsset: async (asset) => { record = { ...asset }; },
                    putObject: async () => undefined,
                    finalizeAsset: (asset, options) => finalizeStagedCoverArtLifecycleRecord(
                        asset,
                        options,
                        {
                            runWithOwnerFence: async () => {
                                throw Object.assign(new Error('commit response lost'), {
                                    hasErrorLabel: (label: string) => label === 'UnknownTransactionCommitResult'
                                });
                            },
                            updatePendingAsset: async () => ({ matchedCount: 0 }),
                            findAsset: async () => {
                                if (readbackFails) throw new Error('readback unavailable');
                                return record;
                            }
                        }
                    ),
                    deleteObject: async () => { deleteCalls += 1; },
                    markFailedAsset: async () => { failedUpdates += 1; }
                }
            ),
            (error: any) => error?.code === 'cover_art_upload_outcome_unknown'
                && error?.cleanupPending === true
                && error?.reconciliationRequired === true
        );
        assert.equal(record.uploadStatus, 'pending');
        assert.equal(deleteCalls, 0);
        assert.equal(failedUpdates, 0);
    }
});

test('public cover art accepts ready catalog images', () => {
    assert.equal(isPublicCoverArtAsset(readyAsset('artist')), true);
    assert.equal(isPublicCoverArtAsset(readyAsset('album')), true);
    assert.equal(isPublicCoverArtAsset(readyAsset('audioTrack')), true);
});

test('public cover art rejects private avatars and incomplete catalog images', () => {
    assert.equal(isPublicCoverArtAsset(readyAsset('user')), false);
    assert.equal(isPublicCoverArtAsset({ ownerType: 'album', uploadStatus: 'pending' }), false);
    assert.equal(isPublicCoverArtAsset(null), false);
});

test('public cover art rejects a ready private avatar before requesting storage', async () => {
    let storageCalls = 0;
    const result = await getCoverArtObject('private-avatar', {}, {
        findAsset: async () => ({
            ownerType: 'user',
            ownerId: 'listener',
            uploadStatus: 'ready',
            s3Key: 'avatars/private-avatar'
        }) as any,
        getObject: async () => {
            storageCalls += 1;
            throw new Error('Private storage must not be reached.');
        }
    });

    assert.equal(result, null);
    assert.equal(storageCalls, 0);
});

test('public cover art rejects an attached catalog record whose key targets another image identity', async () => {
    let storageCalls = 0;
    const result = await getCoverArtObject(imageId, {}, {
        findAsset: async () => ({
            ...readyAsset('album'),
            s3Key: 'images/507f1f77bcf86cd799439012'
        }),
        findOwner: async () => attachedOwner,
        getObject: async () => {
            storageCalls += 1;
            return {};
        }
    });
    assert.equal(result, null);
    assert.equal(storageCalls, 0);
});

test('cover-art upload validation decodes allowed bytes instead of trusting signatures', async () => {
    const validPng = await sharp({
        create: { width: 12, height: 12, channels: 3, background: '#336699' }
    }).png().toBuffer();
    await validateCoverArtFile(uploadedFile(validPng, 'image/png'));

    const signatureOnlyPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await assert.rejects(
        validateCoverArtFile(uploadedFile(signatureOnlyPng, 'image/png')),
        (error: any) => error?.statusCode === 400
    );

    const pixels = Buffer.alloc(128 * 128 * 3);
    for (let index = 0; index < pixels.length; index += 1) pixels[index] = (index * 31) % 251;
    const completePng = await sharp(pixels, {
        raw: { width: 128, height: 128, channels: 3 }
    }).png({ compressionLevel: 0 }).toBuffer();
    const truncatedPng = completePng.subarray(0, Math.floor(completePng.length * 0.6));
    await assert.rejects(
        validateCoverArtFile(uploadedFile(truncatedPng, 'image/png')),
        (error: any) => error?.statusCode === 400
    );
});

test('public cover art requires the current owner to retain the image reference', async () => {
    let storageCalls = 0;
    const detached = await getCoverArtObject(imageId, {}, {
        findAsset: async () => readyAsset('album'),
        findOwner: async () => ({ coverArtId: '507f1f77bcf86cd799439012' }),
        getObject: async () => {
            storageCalls += 1;
            return {};
        }
    });
    assert.equal(detached, null);
    assert.equal(storageCalls, 0);

    const attached = await resolvePublicCoverArtAsset(imageId, {
        findAsset: async () => readyAsset('album'),
        findOwner: async () => attachedOwner
    });
    assert.equal(attached?.s3Key, `images/${imageId}`);
});

test('public cover art requires an exact ready Soundtrack owner lifecycle', async () => {
    const asset = readyAsset('audioTrack');
    for (const owner of [
        { ...attachedOwner, uploadStatus: 'failed' },
        { ...attachedOwner, uploadStatus: 'deleting' },
        { ...attachedOwner, uploadStatus: 'deleteFailed' },
        { ...attachedOwner, s3Key: '507f191e810c19729de860eb' },
        { ...attachedOwner, publicationStatus: null },
        { ...attachedOwner, publicationStatus: '' },
        { ...attachedOwner, publicationStatus: 'unexpected' }
    ]) {
        assert.equal(await resolvePublicCoverArtAsset(imageId, {
            findAsset: async () => asset,
            findOwner: async () => owner
        }), null);
    }

    for (const owner of [
        attachedOwner,
        { ...attachedOwner, publicationStatus: 'ready' }
    ]) {
        assert.equal((await resolvePublicCoverArtAsset(imageId, {
            findAsset: async () => asset,
            findOwner: async () => owner
        }))?.s3Key, `images/${imageId}`);
    }
});

test('public cover art excludes non-ready Album owners', async () => {
    const asset = readyAsset('album');
    for (const lifecycleStatus of ['deleting', 'deleteFailed']) {
        assert.equal(await resolvePublicCoverArtAsset(imageId, {
            findAsset: async () => asset,
            findOwner: async () => ({ ...attachedOwner, lifecycleStatus })
        }), null);
    }
});

test('original artwork keeps forwarding its own conditional validator after owner validation', async () => {
    let received: unknown;
    const result = await getCoverArtObject(imageId, { ifNoneMatch: '"source"' }, {
        findAsset: async () => readyAsset('artist'),
        findOwner: async () => attachedOwner,
        getObject: async (input) => {
            received = input;
            return { Body: Readable.from(Buffer.from('source')) };
        }
    });

    assert.equal(result?.notModified, false);
    assert.deepEqual(received, {
        s3Key: `images/${imageId}`,
        ifNoneMatch: '"source"',
        abortSignal: undefined
    });
});

test('original artwork never reflects wildcard or multi-value request validators', async () => {
    for (const ifNoneMatch of ['*', '"old", "current"']) {
        const result = await getCoverArtObject(imageId, { ifNoneMatch }, {
            findAsset: async () => readyAsset('artist'),
            findOwner: async () => attachedOwner,
            getObject: async () => {
                throw { $metadata: { httpStatusCode: 304 } };
            }
        });
        assert.equal(result?.notModified, true);
        assert.equal(result?.etag, undefined);
    }

    const result = await getCoverArtObject(imageId, { ifNoneMatch: '"current"' }, {
        findAsset: async () => readyAsset('artist'),
        findOwner: async () => attachedOwner,
        getObject: async () => {
            throw {
                $metadata: { httpStatusCode: 304 },
                $response: { headers: { etag: '"current"' } }
            };
        }
    });
    assert.equal(result?.etag, '"current"');
});

test('the v1 derivative width contract is a fixed allowlist', () => {
    assert.deepEqual(coverArtVariantWidths, [96, 192, 320, 480, 640, 960, 1280]);
    for (const width of coverArtVariantWidths) assert.equal(isCoverArtVariantWidth(String(width)), true);
    for (const width of [0, 95, 97, 192.5, 256, 1281, '96px', '096', '96.0', ' 96 ', '']) {
        assert.equal(isCoverArtVariantWidth(width), false);
    }
});

test('invalid derivative widths fail before database, storage, or Sharp work', async () => {
    let calls = 0;
    await assert.rejects(
        getCoverArtVariant(imageId, 97, {}, {
            findAsset: async () => {
                calls += 1;
                return readyAsset('album');
            },
            findOwner: async () => {
                calls += 1;
                return attachedOwner;
            },
            getObject: async () => {
                calls += 1;
                return {};
            },
            transform: async () => {
                calls += 1;
                return Buffer.alloc(0);
            }
        }),
        (error: any) => error?.statusCode === 400
    );
    assert.equal(calls, 0);
});

test('a matching v1 validator checks ownership but skips S3 and Sharp', async () => {
    let ownerCalls = 0;
    let storageCalls = 0;
    let transformCalls = 0;
    const etag = coverArtVariantEtag(imageId, 320);
    const result = await getCoverArtVariant(imageId, 320, {
        ifNoneMatch: `"unrelated", W/${etag}`
    }, {
        findAsset: async () => readyAsset('audioTrack'),
        findOwner: async () => {
            ownerCalls += 1;
            return attachedOwner;
        },
        getObject: async () => {
            storageCalls += 1;
            return {};
        },
        transform: async () => {
            transformCalls += 1;
            return Buffer.alloc(0);
        }
    });

    assert.equal(ownerCalls, 1);
    assert.equal(storageCalls, 0);
    assert.equal(transformCalls, 0);
    assert.deepEqual(result, {
        asset: readyAsset('audioTrack'),
        etag,
        notModified: true
    });
});

test('a v1 derivative never forwards its representation validator to S3', async () => {
    const source = await sharp({
        create: { width: 16, height: 12, channels: 3, background: '#224466' }
    }).png().toBuffer();
    let storageInput: Record<string, unknown> | undefined;
    let transformedWidth = 0;
    const result = await getCoverArtVariant(imageId, 192, {
        ifNoneMatch: '"stale-variant"'
    }, {
        findAsset: async () => readyAsset('album'),
        findOwner: async () => attachedOwner,
        getObject: async (input) => {
            storageInput = input;
            return { Body: Readable.from(source), ContentLength: source.length };
        },
        transform: async (input, width) => {
            assert.deepEqual(input, source);
            transformedWidth = width;
            return Buffer.from('derived');
        }
    });

    assert.deepEqual(storageInput, {
        s3Key: `images/${imageId}`,
        abortSignal: undefined
    });
    assert.equal(Object.hasOwn(storageInput ?? {}, 'ifNoneMatch'), false);
    assert.equal(transformedWidth, 192);
    assert.equal(result?.body?.toString(), 'derived');
    assert.equal(result?.etag, coverArtVariantEtag(imageId, 192));
    assert.equal(result?.notModified, false);
});

test('Sharp applies orientation and emits an exact metadata-free square WebP', async () => {
    const source = await sharp({
        create: { width: 40, height: 20, channels: 3, background: '#884422' }
    }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const output = await transformCoverArtVariant(source, 320);
    const metadata = await sharp(output).metadata();

    assert.equal(metadata.format, 'webp');
    assert.equal(metadata.width, 320);
    assert.equal(metadata.height, 320);
    assert.equal(metadata.orientation, undefined);
    assert.equal(metadata.exif, undefined);
});

test('derivative decoding enforces the configured pixel ceiling', async () => {
    const source = await sharp({
        create: { width: 20, height: 20, channels: 3, background: '#112233' }
    }).png().toBuffer();
    await assert.rejects(
        transformCoverArtVariant(source, 96, { maxInputPixels: 100 }),
        /pixel limit/i
    );
});

test('declared and streamed derivative inputs are byte-bounded before Sharp', async () => {
    for (const includeDeclaredLength of [true, false]) {
        let transformCalls = 0;
        await assert.rejects(
            getCoverArtVariant(imageId, 96, {}, {
                findAsset: async () => readyAsset('album'),
                findOwner: async () => attachedOwner,
                getObject: async () => ({
                    Body: Readable.from(Buffer.from('12345')),
                    ...(includeDeclaredLength ? { ContentLength: 5 } : {})
                }),
                maxInputBytes: 4,
                transform: async () => {
                    transformCalls += 1;
                    return Buffer.alloc(0);
                }
            }),
            (error: any) => error?.statusCode === 413
        );
        assert.equal(transformCalls, 0);
    }
});
