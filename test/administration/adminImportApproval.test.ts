/** The publish body bound that runs before a one-step approval's intent is fingerprinted, and the cover choice it may carry. All values are synthetic. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
// The database module loads first; importing adminImportService before it trips the index import cycle.
import '../../src/infrastructure/database';
import { AdminImportError } from '../../src/administration/import/adminImportContract';
import { boundImportApproval } from '../../src/administration/import/adminImportApproval';
import { importCoverSelectable, type ImportAsset, type ImportMedia } from '../../src/administration/import/adminImportMediaTypes';

const operationId = '00000009-0000-4000-8000-0000000000b1';
const decision = { scope: 'album', slotId: null, entryKey: null, action: 'create-distinct', candidateId: null, candidateRevision: null };
const change = { path: 'album.title', base: 'Synthetic Album', value: 'Retitled' };
const valid = { operationId, expectedRevision: 3, changes: [change], decisions: [decision], selectedCoverSlotId: 'cover', approvalDigest: 'a'.repeat(64) };
const invalid = (body: Record<string, unknown>, label: string) => assert.throws(() => boundImportApproval(body),
    (error: unknown) => error instanceof AdminImportError && error.status === 400 && error.code === 'ADMIN_IMPORT_INVALID_INPUT', label);

test('a publish body from before one-step approval and every bounded approval pass before the fingerprint', () => {
    boundImportApproval({ operationId, expectedRevision: 3 });
    boundImportApproval(valid); boundImportApproval({ ...valid, changes: [], decisions: [], selectedCoverSlotId: null });
    boundImportApproval({ ...valid, changes: Array.from({ length: 305 }, () => change), decisions: Array.from({ length: 122 }, () => decision), selectedCoverSlotId: `embedded-${operationId}` });
    // A partial body or a malformed digest passes here and is refused after receipt lookup, so a stored receipt of that operation
    // still answers it as an operation conflict.
    const { approvalDigest: _digest, ...partial } = valid;
    boundImportApproval(partial); boundImportApproval({ ...valid, approvalDigest: 'Z'.repeat(64) });
});

test('approval fields that are unbounded, nested too deep or of the wrong type are invalid input before the fingerprint', () => {
    let deep: unknown = []; for (let level = 0; level < 60_000; level++) deep = [deep];
    for (const [label, fields] of [
        ['changes nested too deep', { changes: [{ ...change, base: deep }] }], ['a change over a draft', { changes: [{ ...change, value: 'v'.repeat(48_001) }] }],
        ['too many changes', { changes: Array.from({ length: 306 }, () => change) }], ['changes that are not a list', { changes: { 0: change } }], ['a change with an extra key', { changes: [{ ...change, extra: 1 }] }],
        ['more than 122 decisions', { decisions: Array.from({ length: 123 }, () => decision) }], ['a nested decision', { decisions: [{ ...decision, scope: ['album'] }] }],
        ['a decision over 1 KB', { decisions: [{ ...decision, candidateRevision: 'r'.repeat(1_000) }] }], ['decisions nested too deep', { decisions: [deep] }], ['decisions that are not a list', { decisions: null }],
        ['a cover that is not text', { selectedCoverSlotId: 7 }], ['a cover over 64 characters', { selectedCoverSlotId: 'c'.repeat(65) }],
        ['a digest that is not text', { approvalDigest: null }], ['a digest over 64 characters', { approvalDigest: 'a'.repeat(65) }],
        // As /decisions bounds them: no admitted approval reuses one Artist twice, so refusing it here never refuses a replay.
        ['two entries reusing one Artist', { decisions: ['00000009-0000-4000-8000-0000000000e1', '00000009-0000-4000-8000-0000000000e2'].map(entryKey =>
            ({ scope: 'artist', slotId: null, entryKey, action: 'reuse', candidateId: 'f'.repeat(24), candidateRevision: 'c'.repeat(64) })) }]
    ] as const) invalid({ ...valid, ...fields }, label);
});

test('a cover choice is no cover or a staged image that is ready, as an approval or an explicit selection saves it', () => {
    const asset = (slotId: string, contentType: string, state: ImportAsset['state']) => ({ slotId, contentType, state }) as ImportAsset;
    const media = { assets: [asset('cover', 'image/png', 'ready'), asset('pending-cover', 'image/jpeg', 'pending'), asset('audio', 'audio/wav', 'ready'), asset('gone', 'image/png', 'deleted')] } as ImportMedia;
    assert.deepEqual([importCoverSelectable(media, null), importCoverSelectable(undefined, null), importCoverSelectable(media, 'cover')], [true, true, true]);
    for (const slotId of ['pending-cover', 'audio', 'gone', 'missing', 7, undefined, { slotId: 'cover' }]) assert.equal(importCoverSelectable(media, slotId), false, String(slotId));
    assert.equal(importCoverSelectable(undefined, 'cover'), false);
});
