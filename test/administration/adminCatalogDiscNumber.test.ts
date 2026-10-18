/**
 * Disc Numbers in the administrator catalog editor: a stored disc enters the editable fields and
 * the revision only when present, so records without one keep their earlier revisions; invalid
 * stored values read as a repairable empty field; snapshots always name the field; and the PATCH
 * parser admits only 1–999 or null for MediaTracks, synchronously, before any transaction.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ObjectId } from 'mongodb';
// adminCatalogService loads the database module first, as in revisionStability.test.ts.
import {
    AdminCatalogError,
    adminCatalogEditableFields,
    adminCatalogItemRevision,
    adminCatalogSnapshot,
    editAdminCatalogItem
} from '../../src/administration/catalog/adminCatalogService';

const ids = { track: '5f1b0000000000000000b101', album: '5f1b0000000000000000a101', actor: '5f1b0000000000000000f101' };
const track = (extra: Record<string, unknown> = {}) => ({
    _id: new ObjectId(ids.track), title: 'Synthetic disc track', uploadStatus: 'ready', publicationStatus: 'ready',
    s3Key: ids.track, albumId: '', trackNumber: 4, ...extra
});
const rejectsInput = (error: unknown) => error instanceof AdminCatalogError && error.statusCode === 400
    && error.code === 'ADMIN_CATALOG_INVALID_INPUT';
const body = (fields: Record<string, unknown>) => ({
    operationId: '00000000-0000-4000-8000-000000000002', expectedRevision: `cr_${'B'.repeat(43)}`, fields
});

test('a record without a stored Disc Number keeps its fields and revision byte for byte', () => {
    const fields = adminCatalogEditableFields('audioTrack', track());
    assert.equal('discNumber' in fields, false);
    const revision = adminCatalogItemRevision('audioTrack', track());
    assert.equal(adminCatalogItemRevision('audioTrack', track({ discNumber: undefined })), revision);
    assert.equal(adminCatalogItemRevision('audioTrack', track({ discNumber: null })), revision);
});

test('a stored Disc Number is an editable field that changes the revision', () => {
    const none = adminCatalogItemRevision('audioTrack', track());
    const two = adminCatalogItemRevision('audioTrack', track({ discNumber: 2, discNumberSource: 'embedded' }));
    const three = adminCatalogItemRevision('audioTrack', track({ discNumber: 3, discNumberSource: 'embedded' }));
    assert.equal(new Set([none, two, three]).size, 3);
    assert.equal(adminCatalogEditableFields('audioTrack', track({ discNumber: 2 })).discNumber, 2);
    // Albums never carry the field.
    assert.equal('discNumber' in adminCatalogEditableFields('album', { ...track({ discNumber: 2 }), audioTrackIds: [] }), false);
});

test('invalid stored Disc Numbers read as an empty field with distinct revisions', () => {
    const revisions = new Set<string>();
    for (const discNumber of [0, 1000, '2', 1.5]) {
        assert.equal(adminCatalogEditableFields('audioTrack', track({ discNumber })).discNumber, null, JSON.stringify(discNumber));
        revisions.add(adminCatalogItemRevision('audioTrack', track({ discNumber })));
    }
    revisions.add(adminCatalogItemRevision('audioTrack', track()));
    assert.equal(revisions.size, 5);
});

test('the PATCH parser admits only whole Disc Numbers 1 to 999 or null on a MediaTrack', async () => {
    for (const discNumber of [0, 1000, 1.5, '2', true, -1]) {
        assert.throws(() => editAdminCatalogItem(ids.actor, 'audioTrack', ids.track, body({ discNumber })), rejectsInput, JSON.stringify(discNumber));
    }
    assert.throws(() => editAdminCatalogItem(ids.actor, 'album', ids.album, body({ discNumber: 2 })), rejectsInput);
    for (const discNumber of [1, 999, null]) {
        // The parser admits the patch; the database step then fails because this unit test has no connection.
        await assert.rejects(editAdminCatalogItem(ids.actor, 'audioTrack', ids.track, body({ discNumber })),
            (error: unknown) => !rejectsInput(error), JSON.stringify(discNumber));
    }
});

test('a MediaTrack snapshot always names its Disc Number and keeps the item revision', async () => {
    const doc = track();
    // Without an albumId the snapshot needs no database read, so no session is used.
    const snapshot = await adminCatalogSnapshot('audioTrack', doc, undefined as never);
    assert.equal(snapshot.fields.discNumber, null);
    assert.equal(snapshot.revision, adminCatalogItemRevision('audioTrack', doc));
    const stored = await adminCatalogSnapshot('audioTrack', track({ discNumber: 7 }), undefined as never);
    assert.equal(stored.fields.discNumber, 7);
    const album = await adminCatalogSnapshot('album', { _id: new ObjectId(ids.album), title: 'Synthetic Album', audioTrackIds: [] }, undefined as never);
    assert.equal('discNumber' in album.fields, false);
});
