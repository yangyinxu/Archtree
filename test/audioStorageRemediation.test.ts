import assert from 'node:assert/strict';
import test from 'node:test';

import {
    AudioStorageRemediationError,
    deleteMissingAudioTrackRecord,
    deleteOrphanedAudioStorageObject,
    type MissingAudioTrackDeletionDependencies,
    type OrphanAudioDeletionDependencies
} from '../src/services/audioStorageRemediationService';

const orphanKey = 'audio/667f4e0ace50714e897961bf/6a66626781d495b9ec430e6b';
const missingTrackId = '667f4e0ace50714e897961bf';
const missingTrackKey = 'audio/667f4e0ace50714e897961bf/6a66626781d495b9ec430e6c';

const dependencies = (
    overrides: Partial<OrphanAudioDeletionDependencies> = {}
): OrphanAudioDeletionDependencies => ({
    reconcile: async () => ({ orphanedObjects: [{ key: orphanKey }] }) as any,
    isReferenced: async () => false,
    objectExists: async () => false,
    deleteObject: async () => undefined,
    ...overrides
});

const missingDependencies = (
    overrides: Partial<MissingAudioTrackDeletionDependencies> = {}
): MissingAudioTrackDeletionDependencies => ({
    reconcile: async () => ({
        missingObjects: [{ audioTrackId: missingTrackId, s3Key: missingTrackKey }]
    }) as any,
    trackExists: async () => true,
    deleteTrack: async () => ({ cleanupPending: false }),
    ...overrides
});

test('deletes only the exact report-confirmed orphan and verifies absence', async () => {
    const calls: string[] = [];
    const result = await deleteOrphanedAudioStorageObject(orphanKey, dependencies({
        isReferenced: async key => { calls.push(`reference:${key}`); return false; },
        deleteObject: async key => { calls.push(`delete:${key}`); },
        objectExists: async key => { calls.push(`head:${key}`); return false; }
    }));

    assert.deepEqual(result, { s3Key: orphanKey, status: 'deleted' });
    assert.deepEqual(calls, [
        `reference:${orphanKey}`,
        `reference:${orphanKey}`,
        `delete:${orphanKey}`,
        `head:${orphanKey}`
    ]);
});

test('rejects invalid namespaces before reconciliation or deletion', async () => {
    let reconciled = false;
    await assert.rejects(
        deleteOrphanedAudioStorageObject('images/private.jpg', dependencies({
            reconcile: async () => { reconciled = true; return {} as any; }
        })),
        (error: any) => error instanceof AudioStorageRemediationError
            && error.statusCode === 400
            && error.code === 'invalid_audio_storage_key'
    );
    assert.equal(reconciled, false);
});

test('preserves every raw database reference even when reconciliation classifies the key as orphaned', async () => {
    let deleted = false;
    await assert.rejects(
        deleteOrphanedAudioStorageObject(orphanKey, dependencies({
            isReferenced: async () => true,
            deleteObject: async () => { deleted = true; }
        })),
        (error: any) => error.code === 'audio_storage_object_referenced'
    );
    assert.equal(deleted, false);
});

test('rechecks raw references after reconciliation and closes a stale report action', async () => {
    let referenceChecks = 0;
    let deleted = false;
    await assert.rejects(
        deleteOrphanedAudioStorageObject(orphanKey, dependencies({
            isReferenced: async () => ++referenceChecks === 2,
            deleteObject: async () => { deleted = true; }
        })),
        (error: any) => error.code === 'audio_storage_object_referenced'
    );
    assert.equal(referenceChecks, 2);
    assert.equal(deleted, false);
});

test('returns an idempotent result when an unreferenced object is already absent', async () => {
    const result = await deleteOrphanedAudioStorageObject(orphanKey, dependencies({
        reconcile: async () => ({ orphanedObjects: [] }) as any,
        objectExists: async () => false
    }));
    assert.equal(result.status, 'alreadyAbsent');
});

test('rejects an existing object that is no longer confirmed orphaned', async () => {
    await assert.rejects(
        deleteOrphanedAudioStorageObject(orphanKey, dependencies({
            reconcile: async () => ({ orphanedObjects: [] }) as any,
            objectExists: async () => true
        })),
        (error: any) => error.code === 'audio_storage_object_not_orphaned'
            && error.statusCode === 409
    );
});

test('reports deletion and verification failures as unresolved outcomes', async () => {
    for (const overrides of [
        { deleteObject: async () => { throw new Error('S3 unavailable'); } },
        { objectExists: async () => true }
    ]) {
        await assert.rejects(
            deleteOrphanedAudioStorageObject(orphanKey, dependencies(overrides)),
            (error: any) => error.code === 'audio_storage_delete_unconfirmed'
                && error.statusCode === 503
                && error.outcomeUnknown === true
        );
    }
});

test('deletes only the exact report-confirmed MongoDB-only Soundtrack', async () => {
    const calls: string[] = [];
    const result = await deleteMissingAudioTrackRecord(
        missingTrackId,
        missingTrackKey,
        missingDependencies({
            deleteTrack: async (audioTrackId, expectedS3Key) => {
                calls.push(`${audioTrackId}:${expectedS3Key}`);
                return { cleanupPending: true };
            }
        })
    );

    assert.deepEqual(result, {
        audioTrackId: missingTrackId,
        status: 'deleted',
        cleanupPending: true
    });
    assert.deepEqual(calls, [`${missingTrackId}:${missingTrackKey}`]);
});

test('rejects malformed or mismatched MongoDB-only deletion identities', async () => {
    for (const [audioTrackId, expectedS3Key] of [
        ['not-an-id', missingTrackKey],
        [missingTrackId, 'audio/aaaaaaaaaaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbbbbbbbbbb']
    ]) {
        await assert.rejects(
            deleteMissingAudioTrackRecord(
                audioTrackId,
                expectedS3Key,
                missingDependencies()
            ),
            (error: any) => error.code === 'invalid_missing_audio_track'
                && error.statusCode === 400
        );
    }
});

test('refuses a stale MongoDB-only action when the record still exists', async () => {
    let deleted = false;
    await assert.rejects(
        deleteMissingAudioTrackRecord(
            missingTrackId,
            missingTrackKey,
            missingDependencies({
                reconcile: async () => ({ missingObjects: [] }) as any,
                deleteTrack: async () => { deleted = true; return { cleanupPending: false }; }
            })
        ),
        (error: any) => error.code === 'audio_track_not_confirmed_missing'
            && error.statusCode === 409
    );
    assert.equal(deleted, false);
});

test('treats a repeated MongoDB-only deletion as complete when the record is absent', async () => {
    const result = await deleteMissingAudioTrackRecord(
        missingTrackId,
        missingTrackKey,
        missingDependencies({
            reconcile: async () => ({ missingObjects: [] }) as any,
            trackExists: async () => false
        })
    );
    assert.equal(result.status, 'alreadyAbsent');
});

test('retains a failed MongoDB-only deletion as a reconciliation outcome', async () => {
    await assert.rejects(
        deleteMissingAudioTrackRecord(
            missingTrackId,
            missingTrackKey,
            missingDependencies({
                deleteTrack: async () => { throw new Error('reference cleanup failed'); }
            })
        ),
        (error: any) => error.code === 'missing_audio_track_delete_failed'
            && error.statusCode === 503
    );
});
