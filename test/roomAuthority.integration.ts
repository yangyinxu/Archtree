import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { ObjectId } from 'mongodb';
import { randomUUID } from 'node:crypto';
import { createRoomAuthority } from '../src/realtime/roomAuthority';
import { issueRoomTicket, redeemRoomTicket } from '../src/realtime/roomTickets';
import { getDatabaseClient, getDb } from '../src/infrastructure/database';
import { startMongoReplicaSet, type MongoReplicaSetHarness } from './support/mongoReplicaSet';
import AuthSession from '../src/models/authSession';

let harness: MongoReplicaSetHarness;
before(async () => { harness = await startMongoReplicaSet('archtree-room-authority-test'); });
after(async () => { await harness?.stop(); });

test('only the live Mongo lease owner may commit, and takeover advances epoch without stale release', async () => {
    const a = createRoomAuthority('synthetic-owner-a');
    const b = createRoomAuthority('synthetic-owner-b');
    assert.equal(await a.acquire(), 1);
    assert.equal(await a.acquire(), 1);
    assert.equal(await b.acquire(), null);
    const session = getDatabaseClient().startSession();
    try {
        session.startTransaction(); assert.equal(await a.assert(session), 1); await session.commitTransaction();
        await getDb()!.collection<{ _id: string; expiresAt: Date }>('socialAuthority').updateOne({ _id: 'rooms-v1' }, { $set: { expiresAt: new Date(0) } });
        assert.equal(await b.acquire(), 2);
        session.startTransaction(); await assert.rejects(a.assert(session)); await session.abortTransaction();
        await a.release();
        session.startTransaction(); assert.equal(await b.assert(session), 2); await session.commitTransaction();
        await b.release();
        session.startTransaction(); await assert.rejects(b.assert(session)); await session.abortTransaction();
    } finally { await session.endSession(); }
});

test('ticket redemption is single use, origin-bound and backed by an active account session', async () => {
    const id = new ObjectId();
    await getDb()!.collection('users').insertOne({ _id: id, email: 'room-ticket@example.test', role: 'user' });
    const sessionId = await AuthSession.create(id.toHexString(), 'synthetic-room-refresh-hash', new Date(Date.now() + 60_000));
    const actor = { userId: id.toHexString(), sessionId, clientId: randomUUID() };
    const origin = 'http://127.0.0.1:19876';
    const issued = await issueRoomTicket(actor, origin);
    const stored = await getDb()!.collection('socialRealtimeTickets').findOne({ accountId: actor.userId });
    assert.equal(JSON.stringify(stored).includes(issued.ticket), false);
    assert.equal(await redeemRoomTicket(issued.ticket, 'https://untrusted.invalid'), null);
    const results = await Promise.all([redeemRoomTicket(issued.ticket, origin), redeemRoomTicket(issued.ticket, origin)]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.deepEqual(results.find(Boolean), actor);
    const expired = await issueRoomTicket(actor, origin);
    await getDb()!.collection('socialRealtimeTickets').updateMany({ accountId: actor.userId }, { $set: { expiresAt: new Date(0) } });
    assert.equal(await redeemRoomTicket(expired.ticket, origin), null);
    const revoked = await issueRoomTicket(actor, origin);
    await AuthSession.revokeById(actor.userId, actor.sessionId);
    assert.equal(await redeemRoomTicket(revoked.ticket, origin), null);
    await assert.rejects(issueRoomTicket(actor, origin));
});

test('malformed or exhausted authority counters cannot issue an epoch or authorize a commit', async () => {
    const collection = getDb()!.collection('socialAuthority');
    for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, 'invalid']) {
        await collection.deleteMany({});
        await collection.insertOne({ _id: 'rooms-v1' as any, owner: '', epoch: value, fence: 0, expiresAt: new Date(0) });
        assert.equal(await createRoomAuthority().acquire().catch(() => null), null);
    }
    for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, 'invalid']) {
        await collection.deleteMany({});
        const authority = createRoomAuthority(); assert.equal(await authority.acquire(), 1);
        await collection.updateOne({ _id: 'rooms-v1' as any }, { $set: { fence: value } });
        const session = getDatabaseClient().startSession();
        try {
            session.startTransaction(); await assert.rejects(authority.assert(session)); await session.abortTransaction();
            assert.equal(await authority.acquire().catch(() => null), null);
        } finally { if (session.inTransaction()) await session.abortTransaction(); await session.endSession(); }
    }
    await collection.deleteMany({});
});
