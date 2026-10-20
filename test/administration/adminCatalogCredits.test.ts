/**
 * Administrator catalog Credit handling with editable join phrases: snapshot fields carry each
 * valid stored phrase (an invalid one reads as absent), every stored phrase change moves the
 * revision, and a PATCH whose phrase is present but invalid is rejected synchronously, before
 * any transaction or receipt, while valid phrases (Organization Credits included) are admitted.
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
const withPhrase = [...fiveKeys, 'joinPhrase'];
const rejectsInput = (error: unknown) => error instanceof AdminCatalogError && error.statusCode === 400
    && error.code === 'ADMIN_CATALOG_INVALID_INPUT';

test('editable album fields carry each valid stored join phrase and read an invalid one as absent', () => {
    const valid = adminCatalogEditableFields('album', album(' & ')).credits as Array<Record<string, unknown>>;
    assert.deepEqual(valid.map((credit) => Object.keys(credit)), [withPhrase, withPhrase, fiveKeys]);
    assert.deepEqual(valid.map((credit) => credit.joinPhrase), [' & ', ' feat. ', undefined]);
    for (const primaryPhrase of ['x\u200By', null, undefined]) {
        const editable = adminCatalogEditableFields('album', album(primaryPhrase)).credits as Array<Record<string, unknown>>;
        assert.deepEqual(Object.keys(editable[0]), fiveKeys, JSON.stringify(primaryPhrase));
        assert.deepEqual(editable.map((credit) => credit.creditId), ['admin_primary_01', 'admin_featured_01', 'admin_label_01']);
    }
    // A structurally broken list stays a repairable absent list.
    assert.equal(adminCatalogEditableFields('album', { ...album(), credits: [{ subjectType: 'artist', role: 'singer' }] }).credits, null);
});

test('a stored join phrase change changes both the editable fields and the revision', () => {
    assert.notDeepEqual(adminCatalogEditableFields('album', album(' & ')), adminCatalogEditableFields('album', album(' / ')));
    assert.notEqual(adminCatalogItemRevision('album', album(' & ')), adminCatalogItemRevision('album', album(' / ')));
    assert.notEqual(adminCatalogItemRevision('album', album(' & ')), adminCatalogItemRevision('album', album()));
    // An invalid stored phrase reads as absent but is still a distinct stored record.
    assert.deepEqual(adminCatalogEditableFields('album', album('x\u200By')), adminCatalogEditableFields('album', album()));
    assert.notEqual(adminCatalogItemRevision('album', album('x\u200By')), adminCatalogItemRevision('album', album()));
});

const body = (phrases: unknown[]) => ({
    operationId: '00000000-0000-4000-8000-000000000001',
    expectedRevision: `cr_${'A'.repeat(43)}`,
    fields: {
        credits: credits().map(({ joinPhrase: _stored, ...credit }, index) =>
            phrases[index] === undefined ? credit : { ...credit, joinPhrase: phrases[index] }),
        attributionStatus: 'documented'
    }
});

test('a catalog PATCH with a present but invalid join phrase is rejected before any transaction starts', () => {
    for (const phrase of ['x\u200By', null, '', ' ', 'a'.repeat(17), 42]) {
        assert.throws(() => editAdminCatalogItem(ids.actor, 'album', ids.album, body([phrase])), rejectsInput, JSON.stringify(phrase));
        // The label Credit is validated the same way.
        assert.throws(() => editAdminCatalogItem(ids.actor, 'album', ids.album, body([undefined, undefined, phrase])), rejectsInput, JSON.stringify(phrase));
    }
});

test('valid join phrases, including one on a label Credit, pass the synchronous parser', async () => {
    for (const phrases of [[' & '], ['、', ' feat. '], [undefined, undefined, ' / '], []]) {
        // The parser admits the patch; the database step then fails here because this unit test
        // has no connection.
        const pending = editAdminCatalogItem(ids.actor, 'album', ids.album, body(phrases));
        await assert.rejects(pending, (error: unknown) => !rejectsInput(error), JSON.stringify(phrases));
    }
});
