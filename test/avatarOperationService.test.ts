import assert from 'node:assert/strict';
import test from 'node:test';
import { runAvatarOperation, type AvatarOperationDependencies } from '../src/services/avatarOperationService';
import { AvatarLeaseLostError, type AvatarMutationLease, type AvatarMutationPhase } from '../src/services/avatarMutationService';

const setup = (phase: AvatarMutationPhase | undefined, kind: 'replace' | 'delete' = 'replace') => {
    const lease: AvatarMutationLease = { mutationId: 'mutation-1', leaseToken: 'worker-2', record: {
        _id: 'mutation-1', userId: 'user-1', expectedRevision: 1, status: 'pending', kind,
        phase, assetId: kind === 'replace' ? 'replacement' : 'previous', previousAssetId: 'previous', createdAt: new Date()
    } };
    const state = { user: { avatarRevision: 1, avatarAssetId: 'previous' }, asset: { ownerType: 'user', ownerId: 'user-1', avatarMutationId: 'mutation-1', uploadStatus: 'ready', uploadOutcomeUnknown: false, storageIdentity: { etag: '"a"', versionId: 'v1' } } as any,
        uploads: 0, promotions: 0, deletes: 0, finalized: 0, cleanups: 0, cleanupPending: false, validLease: true };
    const assertLease = async () => { if (!state.validLease) throw new AvatarLeaseLostError(); };
    const dependencies: AvatarOperationDependencies = {
        owner: async () => state.user, asset: async () => state.asset,
        phase: async (target, next, fields = {}) => { await assertLease(); Object.assign(target.record, { phase: next, ...fields }); },
        upload: async (_id, _file, target) => { await assertLease(); state.uploads += 1; Object.assign(target!.record, { phase: 'uploaded', assetId: 'replacement' }); return 'replacement'; },
        promote: async target => { await assertLease(); state.promotions += 1; state.user = { avatarRevision: 2, avatarAssetId: 'replacement' }; target.record.phase = 'promoted'; },
        clearOwner: async target => { await assertLease(); state.user = { avatarRevision: 2, avatarAssetId: '' }; target.record.phase = 'cleared'; },
        prepareDelete: async () => { state.deletes += 1; }, finalizeDelete: async () => { state.finalized += 1; state.asset = null; },
        deleteDetached: async () => { state.deletes += 1; },
        cleanup: async () => { state.cleanups += 1; return { cleanupPending: state.cleanupPending, cleanupErrors: [] }; }, assertLease
    };
    return { lease, state, dependencies };
};

test('never-dispatched and legacy crashed reservations retire without deleting unknown evidence', async () => {
    for (const phase of ['reserved', undefined] as const) {
        const f = setup(phase);
        const result = await runAvatarOperation(f.lease, undefined, true, f.dependencies);
        assert.equal(result.statusCode, phase ? 409 : 503);
        assert.equal(f.state.uploads + f.state.deletes + f.state.promotions, 0);
    }
});

test('new upload promotes once and reports cleanup failure truthfully', async () => {
    const f = setup('reserved'); f.state.cleanupPending = true;
    const result = await runAvatarOperation(f.lease, {} as any, false, f.dependencies);
    assert.equal(result.statusCode, 200);
    assert.equal(result.body?.cleanupPending, true);
    assert.equal(f.state.uploads, 1); assert.equal(f.state.promotions, 1);
});

test('interrupted PUT with unknown outcome cannot be promoted or deleted', async () => {
    const f = setup('uploading'); f.state.asset.uploadOutcomeUnknown = true;
    const result = await runAvatarOperation(f.lease, undefined, true, f.dependencies);
    assert.equal(result.statusCode, 503); assert.equal(result.body?.cleanupPending, true);
    assert.equal(f.state.promotions + f.state.deletes + f.state.cleanups, 0);
});

test('acknowledged upload resumes publication without requiring old image bytes', async () => {
    const f = setup('uploading');
    assert.equal((await runAvatarOperation(f.lease, undefined, true, f.dependencies)).statusCode, 200);
    assert.equal(f.state.uploads, 0); assert.equal(f.state.promotions, 1);
});

test('lost publication acknowledgement resumes from the committed phase exactly once', async () => {
    const f = setup('uploaded'); const promote = f.dependencies.promote;
    f.dependencies.promote = async lease => { await promote(lease); throw new Error('write acknowledgement lost'); };
    await assert.rejects(runAvatarOperation(f.lease, undefined, false, f.dependencies));
    assert.equal(f.lease.record.phase, 'promoted');
    assert.equal((await runAvatarOperation(f.lease, undefined, true, f.dependencies)).statusCode, 200);
    assert.equal(f.state.promotions, 1); assert.equal(f.state.uploads, 0);
});

test('deletion resumes after storage deletion and after owner-clear acknowledgement loss', async () => {
    const f = setup('deleting', 'delete'); const clear = f.dependencies.clearOwner;
    f.dependencies.clearOwner = async lease => { await clear(lease); throw new Error('clear acknowledgement lost'); };
    await assert.rejects(runAvatarOperation(f.lease, undefined, true, f.dependencies));
    assert.equal(f.lease.record.phase, 'cleared');
    const result = await runAvatarOperation(f.lease, undefined, true, f.dependencies);
    assert.equal(result.statusCode, 200); assert.equal(result.body?.avatar, null);
    assert.equal(f.state.deletes, 1); assert.equal(f.state.finalized, 1);
});

test('failed storage deletion never clears owner and remains at recoverable phase', async () => {
    const f = setup('deleting', 'delete'); f.dependencies.prepareDelete = async () => { throw new Error('uncertain delete'); };
    await assert.rejects(runAvatarOperation(f.lease, undefined, true, f.dependencies));
    assert.equal(f.lease.record.phase, 'deleting'); assert.equal(f.state.user.avatarAssetId, 'previous');
    assert.equal(f.state.finalized, 0);
});

test('stale worker cannot promote, clear, or begin cleanup after takeover', async () => {
    for (const [phase, kind] of [['uploaded', 'replace'], ['deleting', 'delete'], ['promoted', 'replace']] as const) {
        const f = setup(phase, kind); f.state.validLease = false;
        await assert.rejects(runAvatarOperation(f.lease, undefined, true, f.dependencies), AvatarLeaseLostError);
        assert.equal(f.state.promotions + f.state.deletes + f.state.cleanups, 0);
    }
});
