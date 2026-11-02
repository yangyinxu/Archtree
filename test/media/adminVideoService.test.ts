import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { ObjectId } from 'mongodb';
import type { AdminVideoProject } from '../../src/models/adminVideoProject';
import { adminVideoCapabilities, newVideoObject, videoApprovalDigest, videoIntent, videoText } from '../../src/services/media/adminVideoService';

/** Synthetic private identities exercise approval binding without a database or object store. */
function project(): AdminVideoProject {
    const sourceId = new ObjectId().toHexString();
    return {
        _id: new ObjectId(), actorId: new ObjectId().toHexString(), createdBy: 'synthetic', revision: 1, createdAt: new Date(0), updatedAt: new Date(0),
        filename: 'source.mov', byteLength: 100, draft: { title: 'Reviewed Video', attribution: 'self', publicName: '', subjectType: 'artist', subjectId: null, albumId: null, visibility: 'public', coverChoice: 'automatic' },
        sourceId, outputId: sourceId, automaticCoverId: null, coverSelectionRevision: 0,
        assets: [{ id: sourceId, kind: 'source', operationId: randomUUID(), bucket: 'synthetic-private', key: 'synthetic-source', filename: 'source.mov', contentType: 'video/quicktime', byteLength: 100,
            sha256: 'a'.repeat(64), state: 'ready', etag: '"version-a"', versionId: 'synthetic-version-a', sent: true, settleAfter: new Date(0), updatedAt: new Date(0) }],
        processing: { state: 'ready', plan: 'remux', step: 'validate', progress: 100, issue: null, facts: { plan: 'remux', durationSeconds: 20, width: 1920, height: 1080, videoCodec: 'hevc', audioCodec: 'aac' } },
        publication: { state: 'idle', operationId: null, mediaTrackId: null, issue: null, cleanupPending: false }, receipts: [], ingresses: [], cancelled: false, cleanupComplete: false, leaseOwner: null, leaseUntil: null,
    };
}
test('Video intents and text enforce exact JSON shape and canonical bounded strings', () => {
    assert.equal(videoText('  e\u0301  ', 20), 'é');
    for (const value of ['a\u200db', 'bad\ntext', '\ud800', '\udc00', 'bad\u2028text']) assert.throws(() => videoText(value, 200), (error: any) => error.statusCode === 400);
    assert.throws(() => videoText(' ', 20, false));
    assert.throws(() => videoIntent({ operationId: randomUUID(), expectedRevision: 1, ownerId: 'injected' }));
    assert.throws(() => videoIntent({ operationId: randomUUID(), expectedRevision: -1 }));
    assert.throws(() => videoIntent({ operationId: 'wrong', expectedRevision: 1 }));
    assert.equal(videoIntent({ operationId: randomUUID(), expectedRevision: 1 }).expectedRevision, 1);
});

test('Video capability requires a separately asserted private bucket but no model provider', () => {
    const names = ['FINITUDE_ADMIN_IMPORT_PRIVATE_STORAGE_READY', 'ADMIN_IMPORT_S3_BUCKET_NAME', 'S3_BUCKET_NAME'] as const;
    const previous = names.map(name => process.env[name]);
    try {
        process.env.FINITUDE_ADMIN_IMPORT_PRIVATE_STORAGE_READY = 'true'; process.env.ADMIN_IMPORT_S3_BUCKET_NAME = 'synthetic-private'; process.env.S3_BUCKET_NAME = 'synthetic-public';
        assert.equal(adminVideoCapabilities().enabled, true); assert.deepEqual(adminVideoCapabilities().acceptedExtensions, ['mp4', 'mov', 'm4v']);
        process.env.ADMIN_IMPORT_S3_BUCKET_NAME = 'synthetic-public'; assert.equal(adminVideoCapabilities().enabled, false);
        process.env.ADMIN_IMPORT_S3_BUCKET_NAME = 'synthetic-private'; process.env.FINITUDE_ADMIN_IMPORT_PRIVATE_STORAGE_READY = 'false'; assert.equal(adminVideoCapabilities().enabled, false);
    } finally { names.forEach((name, at) => previous[at] === undefined ? delete process.env[name] : process.env[name] = previous[at]); }
});

test('approval binds exact source version, signature, cover choice and referenced Album state', () => {
    const original = project(), refs = { subject: null, album: null }, digest = videoApprovalDigest(original, refs);
    assert.match(digest!, /^vp_[0-9a-f]{64}$/);
    for (const change of [
        (doc: AdminVideoProject) => { doc.draft.title = 'Other'; },
        (doc: AdminVideoProject) => { doc.draft.publicName = 'Explicit author'; },
        (doc: AdminVideoProject) => { doc.draft.coverChoice = 'none'; },
        (doc: AdminVideoProject) => { doc.assets[0].versionId = 'other'; },
        (doc: AdminVideoProject) => { doc.assets[0].etag = '"other"'; },
    ]) { const changed = structuredClone(original); change(changed); assert.notEqual(videoApprovalDigest(changed, refs), digest); }
    const unavailable = structuredClone(original); unavailable.assets[0].state = 'unknown'; assert.equal(videoApprovalDigest(unavailable, refs), null);
    const selected = structuredClone(original); selected.draft.albumId = new ObjectId().toHexString(); assert.equal(videoApprovalDigest(selected, refs), null);
    const album = { id: selected.draft.albumId, title: 'Album', revision: 'synthetic-r1', visibility: 'public' as const, coverUrl: null };
    const before = videoApprovalDigest(selected, { subject: null, album });
    assert.notEqual(videoApprovalDigest(selected, { subject: null, album: { ...album, revision: 'synthetic-artwork-r2' } }), before);
});

test('private source and output object intents use fresh keys and retain bounded storage evidence', () => {
    const doc = project(), input = { filename: 'source.mov', contentType: 'video/quicktime', byteLength: 100, sha256: 'a'.repeat(64) };
    const one = newVideoObject(doc, 'source', randomUUID(), input), two = newVideoObject(doc, 'source', randomUUID(), input);
    assert.notEqual(one.key, two.key); assert.equal(one.state, 'pending'); assert.equal(one.sent, false); assert.equal(one.etag, null);
    assert.equal(one.versionId, null); assert.ok(one.settleAfter > new Date()); assert.match(one.key, /^video-projects\//);
});
