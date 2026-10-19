import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startAdminWorker } from '../../src/administration/adminWorkerLifecycle';
import { ADMIN_IMPORT_LIMITS } from '../../src/administration/import/adminImportContract';
import { lunaAnalysisChunks, lunaDispatchIssue } from '../../src/administration/import/adminImportLuna';
import { ImportProviderError, OpenAiImportAnalysisProvider } from '../../src/administration/import/adminImportProvider';

test('worker work is tracked; stop aborts current work and prohibits every later timer admission', async () => {
    let resolve!: () => void, calls = 0, tracked = 0, observed: AbortSignal | undefined;
    const held = new Promise<void>(done => { resolve = done; });
    const stop = startAdminWorker(async signal => { calls++; observed = signal; await held; }, 2, async work => { tracked++; return work(); });
    const stopped = stop(); assert.equal(observed?.aborted, true); resolve(); await stopped;
    await new Promise(done => setTimeout(done, 10)); assert.equal(calls, 1); assert.equal(tracked, 1);
});

test('Luna schema v2 changes no budget: two generations of at most eleven chunks fit the 22 calls, with the same grant and bounds', () => {
    const { generations, attempts, dailyAttempts, tracksPerChunk, outputTokens, inputBytes, grantMs, leaseMs } = ADMIN_IMPORT_LIMITS;
    assert.deepEqual({ generations, attempts, dailyAttempts, tracksPerChunk, outputTokens, inputBytes, grantMs, leaseMs },
        { generations: 2, attempts: 22, dailyAttempts: 220, tracksPerChunk: 10, outputTokens: 4000, inputBytes: 48000, grantMs: 86_400_000, leaseMs: 120_000 });
    const files = Array.from({ length: ADMIN_IMPORT_LIMITS.files }, (_, index) => ({ slotId: `00000001-0000-4000-8000-${String(index).padStart(12, '0')}`, filename: `${index}.mp3`, relativePath: `${index}.mp3`, byteLength: 1 }));
    const chunks = lunaAnalysisChunks(1, { rootLabel: '', files }, null, []);
    assert.equal(chunks.length, 11); assert.ok(chunks.slice(1).every(chunk => chunk.slots.length === 10));
    assert.equal(generations * chunks.length, attempts);
});

test('a chunk left in flight is an unknown outcome that is never dispatched again, before the grant and the budget are read', () => {
    const now = new Date('2026-10-19T00:00:00Z'), valid = new Date(now.getTime() + 1), chunk = (state: string) => ({ state });
    assert.equal(lunaDispatchIssue({ chunks: [chunk('complete'), chunk('inflight'), chunk('pending')], grantExpiresAt: valid }, 0, now), 'providerOutcomeUnknown');
    assert.equal(lunaDispatchIssue({ chunks: [chunk('inflight')], grantExpiresAt: null }, 22, now), 'providerOutcomeUnknown');
    assert.equal(lunaDispatchIssue({ chunks: [chunk('pending')], grantExpiresAt: now }, 0, now), 'grantExpired');
    assert.equal(lunaDispatchIssue({ chunks: [chunk('pending')], grantExpiresAt: null }, 0, now), 'grantExpired');
    assert.equal(lunaDispatchIssue({ chunks: [chunk('pending')], grantExpiresAt: valid }, 22, now), 'budgetExhausted');
    assert.equal(lunaDispatchIssue({ chunks: [chunk('unknown'), chunk('pending')], grantExpiresAt: valid }, 21, now), null);
});

test('a provider 5xx is an unknown outcome after exactly one fetch', async () => {
    const previous = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = 'synthetic-key'; let calls = 0;
    try {
        const provider = new OpenAiImportAnalysisProvider(async () => { calls++; return new Response('private', { status: 502 }); });
        await assert.rejects(provider.analyze({ generation: 1, chunk: 0, manifest: { rootLabel: '', files: [] }, baseline: { album: { title: '', artists: [], label: null, releaseDate: null }, tracks: [] }, slots: [], album: true, lookupContext: null }),
            (error: ImportProviderError) => error.issue === 'providerOutcomeUnknown');
        assert.equal(calls, 1);
    } finally { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; }
});
