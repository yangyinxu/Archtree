/**
 * MusicBrainz IDs in the administrator catalog editor: a stored ID enters the editable fields and the revision only when
 * present, so Artists and Organizations without one keep their earlier revisions; a malformed stored ID reads as a repairable
 * empty field; snapshots of both kinds always name the field; and the PATCH parser admits only a keepable ID (any case, stored
 * lowercase) or null, synchronously, before any transaction.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ObjectId } from 'mongodb';
import {
    AdminCatalogError, adminCatalogEditableFields, adminCatalogItemRevision, adminCatalogSnapshot, editAdminCatalogItem
} from '../../src/administration/catalog/adminCatalogService';
import { MUSICBRAINZ_SPECIAL_PURPOSE_ARTIST_IDS, MUSICBRAINZ_SPECIAL_PURPOSE_LABEL_IDS } from '../../src/utils/musicBrainzId';

const ids = { artist: '5f1b0000000000000000c101', organization: '5f1b0000000000000000c201', album: '5f1b0000000000000000a101', actor: '5f1b0000000000000000f101' };
const mbid = '00000000-0000-4000-8000-0000000000c1';
const records = {
    artist: (extra: Record<string, unknown> = {}) => ({ _id: new ObjectId(ids.artist), name: 'Synthetic Artist', bio: '', birthDate: {}, lifecycleStatus: 'ready', ...extra }),
    organization: (extra: Record<string, unknown> = {}) => ({ _id: new ObjectId(ids.organization), name: 'Synthetic Label', description: '', organizationType: 'label', lifecycleStatus: 'ready', ...extra })
};
const rejectsInput = (error: unknown) => error instanceof AdminCatalogError && error.statusCode === 400 && error.code === 'ADMIN_CATALOG_INVALID_INPUT';
const body = (fields: Record<string, unknown>) => ({ operationId: '00000000-0000-4000-8000-000000000002', expectedRevision: `cr_${'B'.repeat(43)}`, fields });

test('an Artist or Organization without a stored ID keeps its fields and revision byte for byte', () => {
    for (const kind of ['artist', 'organization'] as const) {
        const record = records[kind];
        assert.equal('musicBrainzId' in adminCatalogEditableFields(kind, record()), false);
        const revision = adminCatalogItemRevision(kind, record());
        assert.equal(adminCatalogItemRevision(kind, record({ musicBrainzId: undefined })), revision);
        assert.equal(adminCatalogItemRevision(kind, record({ musicBrainzId: null })), revision);
        const stored = adminCatalogItemRevision(kind, record({ musicBrainzId: mbid }));
        assert.notEqual(stored, revision);
        assert.notEqual(adminCatalogItemRevision(kind, record({ musicBrainzId: '00000000-0000-4000-8000-0000000000c2' })), stored);
        assert.equal(adminCatalogEditableFields(kind, record({ musicBrainzId: mbid })).musicBrainzId, mbid);
    }
});

test('a malformed stored ID reads as an empty field but still changes the revision', () => {
    for (const kind of ['artist', 'organization'] as const) {
        const revisions = new Set([adminCatalogItemRevision(kind, records[kind]())]);
        for (const musicBrainzId of ['not-an-id', 42, mbid.toUpperCase()]) {
            const fields = adminCatalogEditableFields(kind, records[kind]({ musicBrainzId }));
            assert.equal(fields.musicBrainzId, typeof musicBrainzId === 'string' && musicBrainzId.toLowerCase() === mbid ? mbid : null);
            revisions.add(adminCatalogItemRevision(kind, records[kind]({ musicBrainzId })));
        }
        assert.equal(revisions.size, 4);
    }
});

test('snapshots of Artists and Organizations always name the MusicBrainz ID; Albums never carry it', async () => {
    for (const kind of ['artist', 'organization'] as const) {
        const none = await adminCatalogSnapshot(kind, records[kind](), undefined as never);
        assert.equal(none.fields.musicBrainzId, null);
        assert.equal(none.revision, adminCatalogItemRevision(kind, records[kind]()));
        const stored = await adminCatalogSnapshot(kind, records[kind]({ musicBrainzId: mbid }), undefined as never);
        assert.equal(stored.fields.musicBrainzId, mbid);
    }
    const album = await adminCatalogSnapshot('album', { _id: new ObjectId(ids.album), title: 'Synthetic Album', audioTrackIds: [] }, undefined as never);
    assert.equal('musicBrainzId' in album.fields, false);
});

test('the PATCH parser admits only a keepable ID or null on an Artist or Organization', async () => {
    const refused = ['not-an-id', '00000000-0000-0000-0000-000000000000', `${mbid} `, 'a'.repeat(65), 7, true, {}, [mbid],
        MUSICBRAINZ_SPECIAL_PURPOSE_ARTIST_IDS[0], MUSICBRAINZ_SPECIAL_PURPOSE_LABEL_IDS[0]];
    for (const kind of ['artist', 'organization'] as const) {
        for (const musicBrainzId of refused) {
            assert.throws(() => editAdminCatalogItem(ids.actor, kind, ids[kind], body({ musicBrainzId })), rejectsInput, JSON.stringify(musicBrainzId));
        }
        for (const musicBrainzId of [mbid, mbid.toUpperCase(), null]) {
            // The parser admits the patch; the database step then fails because this unit test has no connection.
            await assert.rejects(editAdminCatalogItem(ids.actor, kind, ids[kind], body({ musicBrainzId })), (error: unknown) => !rejectsInput(error), JSON.stringify(musicBrainzId));
        }
    }
    for (const kind of ['album', 'audioTrack'] as const) {
        assert.throws(() => editAdminCatalogItem(ids.actor, kind, ids.album, body({ musicBrainzId: mbid })), rejectsInput);
    }
});
