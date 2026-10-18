/**
 * Administrator catalog Credit handling while join phrases are stored but not yet editable
 * (S1): the editor's strict Web schema still receives five-key Credits, stored phrases keep
 * changing the revision, and a PATCH that tries to write a phrase is rejected before any
 * transaction starts.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ObjectId } from 'mongodb';
// adminCatalogService loads the database module first, as in revisionStability.test.ts.
import {
    AdminCatalogError,
    adminCatalogEditableFields,
    adminCatalogItemRevision,
    editAdminCatalogItem
} from '../../src/administration/catalog/adminCatalogService';

const ids = {
    album: '5f1b0000000000000000a001',
    artist: '5f1b0000000000000000c001',
    featured: '5f1b0000000000000000c002',
    label: '5f1b0000000000000000d001',
    actor: '5f1b0000000000000000f001'
};
const credits = (primaryPhrase?: unknown) => [
    {
        creditId: 'admin_primary_01', subjectType: 'artist', subjectId: ids.artist, role: 'primary', order: 0,
        ...(primaryPhrase === undefined ? {} : { joinPhrase: primaryPhrase })
    },
    { creditId: 'admin_featured_01', subjectType: 'artist', subjectId: ids.featured, role: 'featured', order: 1, joinPhrase: ' feat. ' },
    { creditId: 'admin_label_01', subjectType: 'organization', subjectId: ids.label, role: 'label', order: 2 }
];
const album = (primaryPhrase?: unknown) => ({
    _id: new ObjectId(ids.album), title: 'Synthetic Album', lifecycleStatus: 'ready', audioTrackIds: [],
    attributionStatus: 'documented', creditRevision: 3, credits: credits(primaryPhrase)
});
const fiveKeys = ['creditId', 'subjectType', 'subjectId', 'role', 'order'];

test('editable album fields expose five-key Credits whether stored phrases are valid or invalid', () => {
    for (const primaryPhrase of [' & ', 'x\u200By', null, undefined]) {
        const fields = adminCatalogEditableFields('album', album(primaryPhrase));
        const editable = fields.credits as Array<Record<string, unknown>>;
        assert.equal(editable.length, 3, JSON.stringify(primaryPhrase));
        for (const credit of editable) assert.deepEqual(Object.keys(credit), fiveKeys);
        assert.deepEqual(editable.map((credit) => credit.creditId), ['admin_primary_01', 'admin_featured_01', 'admin_label_01']);
    }
    // A structurally broken list stays a repairable absent list.
    assert.equal(adminCatalogEditableFields('album', { ...album(), credits: [{ subjectType: 'artist', role: 'singer' }] }).credits, null);
});

test('a stored phrase change still changes the catalog revision', () => {
    assert.deepEqual(adminCatalogEditableFields('album', album(' & ')), adminCatalogEditableFields('album', album(' / ')));
    assert.notEqual(adminCatalogItemRevision('album', album(' & ')), adminCatalogItemRevision('album', album(' / ')));
    assert.notEqual(adminCatalogItemRevision('album', album(' & ')), adminCatalogItemRevision('album', album()));
});

test('a catalog PATCH that carries a join phrase is rejected before any transaction starts', async () => {
    // The editor's five-key Credits, with an optional phrase on the first one.
    const patchCredits = (joinPhrase?: unknown) => credits().map(({ joinPhrase: _stored, ...credit }, index) =>
        index === 0 && joinPhrase !== undefined ? { ...credit, joinPhrase } : credit);
    const body = (joinPhrase?: unknown) => ({
        operationId: '00000000-0000-4000-8000-000000000001',
        expectedRevision: `cr_${'A'.repeat(43)}`,
        fields: { credits: patchCredits(joinPhrase), attributionStatus: 'documented' }
    });
    for (const primaryPhrase of [' & ', 'x\u200By', null]) {
        assert.throws(
            () => editAdminCatalogItem(ids.actor, 'album', ids.album, body(primaryPhrase)),
            (error: unknown) => error instanceof AdminCatalogError && error.statusCode === 400
                && error.code === 'ADMIN_CATALOG_INVALID_INPUT',
            JSON.stringify(primaryPhrase)
        );
    }
    // Without phrases the synchronous parser admits the patch; the database step then fails here
    // because this unit test has no connection.
    const pending = editAdminCatalogItem(ids.actor, 'album', ids.album, body());
    await assert.rejects(pending);
});
