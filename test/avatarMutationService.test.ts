import assert from 'node:assert/strict';
import test from 'node:test';
import { initializeAvatarMutationRecovery } from '../src/services/avatarMutationService';

test('startup idempotently removes TTL only from pending receipts before readiness', async () => {
    const calls: any[] = [];
    const db: any = { collection: (name: string) => {
        assert.equal(name, 'avatarMutations');
        return {
            updateMany: async (filter: any, update: any) => { calls.push({ filter, update }); },
            createIndex: async (keys: any, options: any) => { calls.push({ keys, options }); }
        };
    } };
    await initializeAvatarMutationRecovery(db);
    await initializeAvatarMutationRecovery(db);
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[0], { filter: { status: 'pending', expiresAt: { $exists: true } }, update: { $unset: { expiresAt: '' } } });
    assert.deepEqual(calls[1], { keys: { expiresAt: 1 }, options: { expireAfterSeconds: 0 } });
});

test('failed startup receipt migration is retryable and never silently ready', async () => {
    let attempts = 0;
    const db: any = { collection: () => ({ updateMany: async () => { if (++attempts === 1) throw new Error('unavailable'); }, createIndex: async () => undefined }) };
    await assert.rejects(initializeAvatarMutationRecovery(db));
    await initializeAvatarMutationRecovery(db);
    assert.equal(attempts, 2);
});
