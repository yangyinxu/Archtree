import assert from 'node:assert/strict';
import test from 'node:test';

import { reconcileMotionPreviewStorage } from '../../src/services/media/motionPreviewReconciliation';

const trackId = (n: number) => `64c0000000000000000000${n.toString(16).padStart(2, '0')}`;
const videoKey = (id: string, object = 'aa') => `video/${id}/64c0000000000000000000${object}`;
const previewKey = (id: string, object = 'ee') => `motion-preview/${id}/64c0000000000000000000${object}`;

/** A ready Video MediaTrack whose active preview was made for `sourceKey` (its current Video by default). */
const videoTrack = (id: string, overrides: Record<string, unknown> = {}, sourceKey = videoKey(id)) => ({
    _id: id, uploadStatus: 'ready', mediaType: 'video', s3Key: videoKey(id),
    motionPreview: {
        active: { status: 'ready', s3Key: previewKey(id), versionId: 'v1', source: { s3Key: sourceKey } },
        pending: null, cleanup: null, revision: 2
    },
    ...overrides
});

const listed = (...keys: string[]) => keys.map((key) => ({ key, size: 1 }));

test('deletion-owned tracks are not stale preview work while a preview bound to a replaced Video is', () => {
    const current = videoTrack(trackId(1));
    const replaced = videoTrack(trackId(2), {}, videoKey(trackId(2), 'bb'));
    // Both also hold a replaced source, so only the deletion status keeps them out of the stale list.
    const deleteFailed = videoTrack(trackId(3), { uploadStatus: 'deleteFailed' }, videoKey(trackId(3), 'bb'));
    const deleting = videoTrack(trackId(4), { uploadStatus: 'deleting' }, videoKey(trackId(4), 'bb'));
    const tracks = [current, replaced, deleteFailed, deleting];

    const report = reconcileMotionPreviewStorage(tracks, listed(...tracks.map((track) => previewKey(track._id))));

    assert.deepEqual(report.staleTracks, [{ audioTrackId: trackId(2), uploadStatus: 'ready', reason: 'sourceReplaced' }]);
    assert.equal(report.summary.staleTrackCount, 1);
    assert.equal(report.summary.databasePreviewTrackCount, 4);
    assert.deepEqual(report.orphanedObjects, []);
});

test('deletion-owned tracks keep their missing and incomplete preview evidence', () => {
    const deleteFailed = videoTrack(trackId(3), { uploadStatus: 'deleteFailed' });
    deleteFailed.motionPreview.cleanup = {
        status: 'deleteFailed', s3Key: previewKey(trackId(3), 'ef'), versionId: 'v0', reason: 'replaced'
    } as any;
    const deleting = videoTrack(trackId(4), { uploadStatus: 'deleting' });
    deleting.motionPreview.pending = {
        status: 'failed', s3Key: previewKey(trackId(4), 'ef'), outcomeUnknown: true
    } as any;

    // The deleteFailed track's active object is gone from S3; its cleanup object remains.
    const report = reconcileMotionPreviewStorage([deleteFailed, deleting], listed(
        previewKey(trackId(3), 'ef'),
        previewKey(trackId(4))
    ));

    assert.deepEqual(report.staleTracks, []);
    // Their evidence is marked as owned by the deletion, so the audit sends it to a deletion retry.
    assert.deepEqual(report.missingObjects.map(({ audioTrackId, phase, deletionOwned }) => [audioTrackId, phase, deletionOwned]),
        [[trackId(3), 'active', true]]);
    assert.deepEqual(report.incompleteTracks, [
        { audioTrackId: trackId(3), deletionOwned: true, pending: null, cleanup: { status: 'deleteFailed', reason: 'replaced' } },
        { audioTrackId: trackId(4), deletionOwned: true, pending: { status: 'failed', outcomeUnknown: true, leaseUntil: null }, cleanup: null }
    ]);
    const ready = reconcileMotionPreviewStorage([videoTrack(trackId(5))], listed());
    assert.equal(ready.missingObjects[0].deletionOwned, false);
    assert.deepEqual(report.orphanedObjects, []);
});

test('each stale preview records why the public gate hides it', () => {
    const notReady = videoTrack(trackId(5), { uploadStatus: 'failed' });
    const audio = videoTrack(trackId(6), { mediaType: 'audio', s3Key: `audio/${trackId(6)}/64c0000000000000000000aa` });
    const replaced = videoTrack(trackId(7), {}, videoKey(trackId(7), 'bb'));
    const tracks = [notReady, audio, replaced, videoTrack(trackId(8))];

    const report = reconcileMotionPreviewStorage(tracks, listed(...tracks.map((track) => previewKey(track._id))));

    assert.deepEqual(report.staleTracks.map(({ audioTrackId, reason }) => [audioTrackId, reason]), [
        [trackId(5), 'trackNotReady'],
        [trackId(6), 'notVideo'],
        [trackId(7), 'sourceReplaced']
    ]);
});

test('invalid and duplicate keys are never marked deletion-owned, so they keep the investigate advice', () => {
    const owner = videoTrack(trackId(6), { uploadStatus: 'deleteFailed' });
    owner.motionPreview.cleanup = { status: 'deleteFailed', s3Key: 'motion-preview/forged', versionId: 'v0', reason: 'replaced' } as any;
    const report = reconcileMotionPreviewStorage([owner], listed(previewKey(trackId(6))));
    assert.equal(report.invalidStorageKeys.length, 1);
    assert.equal(report.invalidStorageKeys[0].deletionOwned, false);
});
