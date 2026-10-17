import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { readFile } from 'node:fs/promises';
import type { ImportObjectStorage, ImportObjectTarget, ImportObjectIdentity } from '../../src/administration/import/adminImportStorage';
import type { Server } from 'node:http';
import { before, beforeEach, after, test } from 'node:test';
import express from 'express';
import jwt from 'jsonwebtoken';
import { ObjectId } from 'mongodb';
import { getDb } from '../../src/infrastructure/database';
import { createAdminImportRouter } from '../../src/routes/adminImportRoutes';
import { initializeAdminImportStorage } from '../../src/administration/import/adminImportService';
import { startMongoReplicaSet, type MongoReplicaSetHarness } from '../support/mongoReplicaSet';

let harness: MongoReplicaSetHarness, server: Server, base: string, token: string, userToken: string;
const objects = new Map<string, { target: ImportObjectTarget; bytes: Buffer; identity: ImportObjectIdentity }>();
const storage: ImportObjectStorage = {
    async head(target) { return objects.get(target.key)?.identity ?? null; },
    async put(target, file) { const identity = { etag: '"synthetic-etag"', versionId: 'synthetic-version' }; objects.set(target.key, { target, identity, bytes: file.path ? await readFile(file.path) : file.buffer }); return identity; },
    async read(target) { return objects.get(target.key)!.bytes; },
    async delete(target) { objects.delete(target.key); },
    async copy() { throw new Error('Not used'); }
};
const actor = new ObjectId(), ordinary = new ObjectId(), session = new ObjectId(), otherSession = new ObjectId();
const body = () => ({ operationId: randomUUID(), manifest: { rootLabel: 'Synthetic folder', files: [{ slotId: randomUUID(), filename: 'song.mp3', relativePath: 'song.mp3', byteLength: 123 }] } });
const request = (path: string, method = 'GET', value?: unknown, auth = token, extra: Record<string, string> = {}) => fetch(base + path, { method, headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...(value === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra }, ...(value === undefined ? {} : { body: typeof value === 'string' ? value : JSON.stringify(value) }) });
before(async () => {
    harness = await startMongoReplicaSet('archtree-admin-import-routes-test'); const app = express(); app.use('/api/admin/v1', createAdminImportRouter(storage)); app.get('/api/admin/v1/catalog/probe', (_req, res) => res.json({ reached: true })); app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.status ?? 500).json({ code: 'INVALID_REQUEST' }));
    server = await new Promise<Server>(resolve => { const active = app.listen(0, '127.0.0.1', () => resolve(active)); }); const address = server.address(); assert.ok(address && typeof address !== 'string'); base = `http://127.0.0.1:${address.port}`;
});
beforeEach(async () => {
    objects.clear(); process.env.FINITUDE_ADMIN_IMPORTS_ENABLED = 'true'; delete process.env.OPENAI_API_KEY; delete process.env.FINITUDE_ADMIN_IMPORT_PRIVATE_STORAGE_READY;
    for (const name of ['users', 'authSessions', 'adminAlbumImports', 'adminImportAnalysisSlots']) await getDb()!.collection(name).deleteMany({});
    await getDb()!.collection('users').insertMany([{ _id: actor, role: 'admin', email: 'routes-admin@example.test' }, { _id: ordinary, role: 'user', email: 'routes-user@example.test' }]);
    await getDb()!.collection('authSessions').insertMany([{ _id: session, userId: actor.toHexString(), refreshTokenHash: 'synthetic', expiresAt: new Date(Date.now() + 600000) }, { _id: otherSession, userId: ordinary.toHexString(), refreshTokenHash: 'synthetic-other', expiresAt: new Date(Date.now() + 600000) }]);
    const sign = (userId: ObjectId, sessionId: ObjectId) => jwt.sign({ userId: userId.toHexString(), email: userId.equals(actor) ? 'routes-admin@example.test' : 'routes-user@example.test', sessionId: sessionId.toHexString(), tokenType: 'access' }, process.env.JWT_SECRET!, { expiresIn: 600 }); token = sign(actor, session); userToken = sign(ordinary, otherSession); await initializeAdminImportStorage(getDb()!);
});
after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await harness?.stop(); delete process.env.FINITUDE_ADMIN_IMPORTS_ENABLED; });
test('import auth and current-role guards precede JSON parsing and do not intercept adjacent protected routers', async () => {
    const unauthenticated = await request('/api/admin/v1/imports', 'POST', '{broken', ''); assert.equal(unauthenticated.status, 401); assert.equal(unauthenticated.headers.get('cache-control'), 'no-store');
    assert.equal((await request('/api/admin/v1/imports', 'POST', '{broken', userToken)).status, 403);
    assert.equal((await request('/api/admin/v1/imports', 'POST', '{broken')).status, 400);
    const adjacent = await request('/api/admin/v1/catalog/probe', 'GET', undefined, ''); assert.equal(adjacent.status, 200); assert.deepEqual(await adjacent.json(), { reached: true });
});
test('cookie-owned import reads require exact viewer and create/replay uses top-level bounded codes', async () => {
    assert.equal((await request('/api/admin/v1/imports', 'GET', undefined, '', { Cookie: `session_token=${token}` })).status, 409);
    assert.equal((await request('/api/admin/v1/imports', 'GET', undefined, '', { Cookie: `session_token=${token}`, 'X-Finitude-Account-Viewer': actor.toHexString() })).status, 200);
    const value = body(), first = await request('/api/admin/v1/imports', 'POST', value); assert.equal(first.status, 201); const result = await first.json();
    const replay = await request('/api/admin/v1/imports', 'POST', value); assert.equal(replay.status, 201); assert.equal((await replay.json()).item.id, result.item.id);
    const invalid = await request(`/api/admin/v1/imports/${result.item.id}`, 'PATCH', { operationId: randomUUID(), expectedRevision: 9, draft: result.item.draft }); assert.equal(invalid.status, 409); assert.deepEqual(await invalid.json(), { code: 'ADMIN_IMPORT_REVISION_CONFLICT' });
});
test('unconfigured provider and private storage reject admission without provider/S3 dispatch', async () => {
    const created = await (await request('/api/admin/v1/imports', 'POST', body())).json();
    const analysis = await request(`/api/admin/v1/imports/${created.item.id}/analyze`, 'POST', { operationId: randomUUID(), expectedRevision: 1 }); assert.equal(analysis.status, 503); assert.equal((await analysis.json()).code, 'ADMIN_IMPORT_PROVIDER_UNAVAILABLE');
    const upload = await request(`/api/admin/v1/imports/${created.item.id}/assets/${created.item.manifest.files[0].slotId}`, 'POST', 'invalid multipart', token, { 'Content-Type': 'multipart/form-data; boundary=synthetic', 'Idempotency-Key': randomUUID(), 'If-Match': '1' }); assert.equal(upload.status, 503); assert.equal((await upload.json()).code, 'ADMIN_IMPORT_STORAGE_UNAVAILABLE');
    const detail = await (await request(`/api/admin/v1/imports/${created.item.id}`)).json(); assert.equal(detail.item.analysis.state, 'idle'); assert.equal(detail.item.assets.length, 0);
});

test('multipart Unicode filename and image preview remain bounded behind exact cookie viewer and current admin', async () => {
    process.env.FINITUDE_ADMIN_IMPORT_PRIVATE_STORAGE_READY = 'true'; process.env.ADMIN_IMPORT_S3_BUCKET_NAME = 'synthetic-private'; process.env.S3_BUCKET_NAME = 'synthetic-catalog';
    const created = await (await request('/api/admin/v1/imports', 'POST', body())).json(), png = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#fa8' } }).png().toBuffer();
    const operationId = randomUUID(), boundary = 'bounded-synthetic';
    const payload = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="upload"; filename*=UTF-8''${encodeURIComponent('封面 "review".png')}\r\nContent-Type: image/png\r\n\r\n`), png, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const upload = await fetch(`${base}/api/admin/v1/imports/${created.item.id}/assets/cover`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Idempotency-Key': operationId, 'If-Match': '1' }, body: payload }); assert.equal(upload.status, 200); const result = await upload.json(); assert.equal(result.item.assets[0].state, 'ready');
    const stored = await getDb()!.collection('adminAlbumImports').findOne({ _id: new ObjectId(created.item.id) }); assert.equal(stored!.media.assets[0].filename, '封面 "review".png');
    const preview = `/api/admin/v1/imports/${created.item.id}/assets/cover/preview`, cookie = { Cookie: `session_token=${token}` };
    assert.equal((await request(preview, 'GET', undefined, '', cookie)).status, 409);
    assert.equal((await request(`${preview}?viewer=${ordinary.toHexString()}`, 'GET', undefined, '', cookie)).status, 409);
    const read = await request(`${preview}?viewer=${actor.toHexString()}`, 'GET', undefined, '', cookie); assert.equal(read.status, 200); assert.equal(read.headers.get('cache-control'), 'no-store'); assert.equal(read.headers.get('content-type')?.startsWith('image/png'), true); assert.deepEqual(Buffer.from(await read.arrayBuffer()), png);
    assert.equal((await request(`/api/admin/v1/imports/${created.item.id}?viewer=${actor.toHexString()}`, 'GET', undefined, '', cookie)).status, 409);
    await getDb()!.collection('users').updateOne({ _id: actor }, { $set: { role: 'user' } }); assert.equal((await request(`${preview}?viewer=${actor.toHexString()}`, 'GET', undefined, '', cookie)).status, 403);
});

test('publication cancellation uses the guarded private route and a new immutable approval-bound receipt', async () => {
    const created = await (await request('/api/admin/v1/imports', 'POST', body())).json(), publicationOperationId = randomUUID();
    await getDb()!.collection('adminAlbumImports').updateOne({ _id: new ObjectId(created.item.id) }, { $set: { 'media.publication': {
        operationId: publicationOperationId, actorId: actor.toHexString(), state: 'needsAttention', tracks: [], cover: null,
        leaseOwner: null, leaseUntil: new Date(Date.now() + 60_000), grantExpiresAt: new Date(0)
    } } });
    const path = `/api/admin/v1/imports/${created.item.id}/cancel-publication`, intent = { operationId: randomUUID(), expectedRevision: 1, publicationOperationId };
    assert.equal((await request(path, 'POST', '{broken', '')).status, 401);
    assert.equal((await request(path, 'POST', '{broken', userToken)).status, 403);
    assert.equal((await request(path, 'POST', { ...intent, expectedRevision: 99 })).status, 409);
    const active = await request(path, 'POST', intent); assert.equal(active.status, 409); assert.equal((await active.json()).code, 'ADMIN_IMPORT_PUBLICATION_ACTIVE');
    await getDb()!.collection('adminAlbumImports').updateOne({ _id: new ObjectId(created.item.id) }, { $set: { 'media.publication.leaseUntil': null } });
    process.env.FINITUDE_ADMIN_IMPORTS_ENABLED = 'false';
    const cancelled = await request(path, 'POST', intent); assert.equal(cancelled.status, 200); assert.equal(cancelled.headers.get('cache-control'), 'no-store');
    const result = await cancelled.json(); assert.equal(result.item.publication, 'cancelled'); assert.deepEqual(result.item.publicationRecovery, { operationId: publicationOperationId, cleanupPending: false, startedByMe: true });
    assert.equal(result.receipt.kind, 'cancel-publication'); assert.equal(result.receipt.operationId, intent.operationId);
    const replay = await request(path, 'POST', intent); assert.equal(replay.status, 200); assert.deepEqual((await replay.json()).receipt, result.receipt);
    assert.equal((await request(path, 'POST', { ...intent, publicationOperationId: randomUUID() })).status, 409);
});
