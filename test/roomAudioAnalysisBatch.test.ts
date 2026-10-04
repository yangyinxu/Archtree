import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { RoomAudioAnalysisInput, RoomAudioAnalysisItem, RoomAudioAnalysisOutcome } from '../src/contracts/roomAudioAnalysis';
import { parseRoomAudioAnalysisArguments, RoomAudioAnalysisArgumentError, runRoomAudioAnalysisBatch } from '../src/services/roomAudioAnalysisBatch';

const actorId = 'a'.repeat(24);
const rowId = (index: number) => index.toString(16).padStart(24, '0');
const item = (index: number, status: RoomAudioAnalysisItem['status'] = 'notAnalyzed'): RoomAudioAnalysisItem => ({
    mediaTrackId: rowId(index), title: 'Private title must stay out of batch output', status,
    sourceRevision: 'b'.repeat(64), attemptId: index.toString(16).padStart(32, '0'), updatedAt: null, reason: null
});
const options = { actorId, apply: true, limit: 25 };
const noAnalyze = async (): Promise<RoomAudioAnalysisOutcome> => { throw new Error('No analysis should be dispatched.'); };

test('argument parsing defaults to bounded dry-run and requires exact explicit apply confirmation', () => {
    assert.deepEqual(parseRoomAudioAnalysisArguments([`--admin-id=${actorId}`]), { actorId, apply: false, limit: 25 });
    assert.deepEqual(parseRoomAudioAnalysisArguments([`--admin-id=${actorId}`, '--limit=100', `--after=${rowId(3)}`, '--apply', '--confirm=ANALYZE_ROOM_AUDIO']),
        { actorId, apply: true, limit: 100, after: rowId(3) });
    for (const args of [
        [], ['--admin-id=bad'], [`--admin-id=${actorId}`, `--admin-id=${actorId}`],
        [`--admin-id=${actorId}`, '--limit=0'], [`--admin-id=${actorId}`, '--limit=101'],
        [`--admin-id=${actorId}`, '--limit=1.5'], [`--admin-id=${actorId}`, '--limit=01'],
        [`--admin-id=${actorId}`, '--after=bad'], [`--admin-id=${actorId}`, '--limit', '25'],
        [`--admin-id=${actorId}`, '--apply'], [`--admin-id=${actorId}`, '--apply=true'],
        [`--admin-id=${actorId}`, '--apply', '--confirm=wrong'],
        [`--admin-id=${actorId}`, '--confirm=ANALYZE_ROOM_AUDIO'],
        [`--admin-id=${actorId}`, '--apply', '--apply', '--confirm=ANALYZE_ROOM_AUDIO'],
        [`--admin-id=${actorId}`, '--unexpected=private-value']
    ]) assert.throws(() => parseRoomAudioAnalysisArguments(args), RoomAudioAnalysisArgumentError);
});

test('dry-run only lists and reports public-safe IDs and aggregates without source tokens or metadata', async () => {
    const report = await runRoomAudioAnalysisBatch({ ...options, apply: false }, {
        list: async input => {
            assert.deepEqual(input, { actorId, after: undefined, limit: 25 });
            return { items: [item(1), item(2, 'retryable'), item(3, 'eligible'), item(4, 'unsupported'), item(5, 'unavailable')], nextAfter: rowId(8) };
        },
        analyze: noAnalyze
    });
    assert.equal(report.dryRun, true);
    assert.equal(report.stopped, false);
    assert.deepEqual(report.counts, { wouldAnalyze: 2, alreadyEligible: 1, unsupported: 1, unavailable: 1 });
    assert.equal(report.resumeAfter, rowId(8), 'the scanned cursor can include filtered Video rows');
    assert.doesNotMatch(JSON.stringify(report), /Private|title|sourceRevision|attemptId|b{64}/);
});

test('apply runs source-bound attempts sequentially and skips settled ineligible rows', async () => {
    const calls: RoomAudioAnalysisInput[] = [];
    let active = false;
    const report = await runRoomAudioAnalysisBatch(options, {
        list: async () => ({ items: [item(1, 'eligible'), item(2, 'retryable'), item(3), item(4, 'unsupported'), item(5, 'unavailable')], nextAfter: null }),
        analyze: async input => {
            assert.equal(active, false);
            active = true;
            calls.push(input);
            await new Promise(resolve => setImmediate(resolve));
            active = false;
            return { mediaTrackId: input.mediaTrackId, attemptId: input.attemptId, outcome: input.mediaTrackId === rowId(2) ? 'complete' : 'unsupported', reason: null };
        }
    });
    assert.deepEqual(calls.map(call => call.mediaTrackId), [rowId(2), rowId(3)]);
    assert.equal(calls[0].attemptId, item(2, 'retryable').attemptId);
    assert.equal(calls[0].sourceRevision, item(2).sourceRevision);
    assert.deepEqual(report.counts, { alreadyEligible: 1, complete: 1, unsupported: 2, unavailable: 1 });
    assert.equal(report.stopped, false);
    assert.equal(report.nextAfter, null);
});

test('every unresolved outcome stops at the previous safe row without dispatching later items', async () => {
    for (const outcome of ['busy', 'unknown', 'failed', 'cancelled', 'stale'] as const) {
        const calls: string[] = [];
        const report = await runRoomAudioAnalysisBatch(options, {
            list: async () => ({ items: [item(1, 'eligible'), item(2), item(3)], nextAfter: rowId(3) }),
            analyze: async input => {
                calls.push(input.mediaTrackId);
                return { mediaTrackId: input.mediaTrackId, attemptId: input.attemptId, outcome, reason: 'analysis_failed' };
            }
        });
        assert.deepEqual(calls, [rowId(2)]);
        assert.equal(report.stopped, true);
        assert.equal(report.stopReason, outcome);
        assert.equal(report.resumeAfter, rowId(1));
        assert.equal(report.nextAfter, rowId(3));
    }
});

test('a running first item is not retried and retains the original resume boundary', async () => {
    for (const after of [undefined, rowId(2)]) {
        const report = await runRoomAudioAnalysisBatch({ ...options, after }, {
            list: async () => ({ items: [item(3, 'running'), item(4)], nextAfter: rowId(4) }), analyze: noAnalyze
        });
        assert.equal(report.stopReason, 'busy');
        assert.equal(report.resumeAfter, after ?? null);
        assert.equal(report.results.length, 1);
    }
});

test('an explicit restart rereads the unresolved row and reuses its service-issued identity', async () => {
    let nextOutcome: RoomAudioAnalysisOutcome['outcome'] = 'unknown';
    const attempts: string[] = [];
    const dependencies = {
        list: async (input: { after?: string }) => ({ items: [item(1, 'eligible'), item(2, 'retryable'), item(3)].filter(row => row.mediaTrackId > (input.after ?? '')), nextAfter: null }),
        analyze: async (input: RoomAudioAnalysisInput): Promise<RoomAudioAnalysisOutcome> => {
            attempts.push(input.attemptId);
            return { mediaTrackId: input.mediaTrackId, attemptId: input.attemptId, outcome: nextOutcome, reason: null };
        }
    };
    const first = await runRoomAudioAnalysisBatch(options, dependencies);
    nextOutcome = 'complete';
    const second = await runRoomAudioAnalysisBatch({ ...options, after: first.resumeAfter ?? undefined }, dependencies);
    assert.equal(second.stopped, false);
    assert.deepEqual(attempts, [item(2).attemptId, item(2).attemptId, item(3).attemptId]);
});

test('uncertain exceptions and mismatched confirmations cannot advance the checkpoint', async () => {
    for (const analyze of [
        async () => { throw new Error('private storage response'); },
        async () => ({ mediaTrackId: rowId(1), attemptId: item(2).attemptId, outcome: 'complete', reason: null }) as RoomAudioAnalysisOutcome
    ]) {
        const report = await runRoomAudioAnalysisBatch(options, { list: async () => ({ items: [item(1)], nextAfter: null }), analyze });
        assert.equal(report.stopReason, 'unknown');
        assert.equal(report.resumeAfter, null);
        assert.doesNotMatch(JSON.stringify(report), /private storage response/);
    }
});

test('cancellation before dispatch performs no reads and cancellation during work preserves the preceding checkpoint', async () => {
    const before = new AbortController(); before.abort();
    const cancelled = await runRoomAudioAnalysisBatch(options, {
        list: async () => { throw new Error('Unexpected read.'); }, analyze: noAnalyze
    }, before.signal);
    assert.equal(cancelled.stopReason, 'cancelled');
    assert.equal(cancelled.listedCount, 0);
    const during = new AbortController();
    const calls: string[] = [];
    const report = await runRoomAudioAnalysisBatch(options, {
        list: async () => ({ items: [item(1, 'eligible'), item(2), item(3)], nextAfter: null }),
        analyze: async input => {
            calls.push(input.mediaTrackId);
            assert.equal(input.signal, during.signal);
            during.abort();
            return { mediaTrackId: input.mediaTrackId, attemptId: input.attemptId, outcome: 'cancelled', reason: 'cancelled' };
        }
    }, during.signal);
    assert.deepEqual(calls, [rowId(2)]);
    assert.equal(report.resumeAfter, rowId(1));
    assert.equal(report.stopReason, 'cancelled');
});

test('a committed item stays complete when cancellation prevents the next item from starting', async () => {
    const controller = new AbortController();
    const report = await runRoomAudioAnalysisBatch(options, {
        list: async () => ({ items: [item(1), item(2)], nextAfter: null }),
        analyze: async input => {
            controller.abort();
            return { mediaTrackId: input.mediaTrackId, attemptId: input.attemptId, outcome: 'complete', reason: null };
        }
    }, controller.signal);
    assert.equal(report.stopReason, 'cancelled');
    assert.equal(report.resumeAfter, rowId(1));
    assert.deepEqual(report.counts, { complete: 1 });
});

test('cancellation while an empty filtered page loads does not advance the checkpoint', async () => {
    const controller = new AbortController();
    const report = await runRoomAudioAnalysisBatch({ ...options, after: rowId(1) }, {
        list: async () => { controller.abort(); return { items: [], nextAfter: rowId(5) }; }, analyze: noAnalyze
    }, controller.signal);
    assert.equal(report.stopReason, 'cancelled');
    assert.equal(report.resumeAfter, rowId(1));
});

test('invalid CLI arguments fail before connecting and never echo the supplied input', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../scripts/analyze-room-audio.ts', import.meta.url)), '--unexpected=private-command-input'], {
        cwd: fileURLToPath(new URL('..', import.meta.url)), timeout: 10_000, encoding: 'utf8',
        env: { ...process.env, DB_CONN_STRING: 'mongodb://127.0.0.1:1/private-fixture', DB_NAME: 'private-fixture' }
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Use --admin-id/);
    assert.doesNotMatch(result.stderr, /private-command-input|private-fixture|database_ready|MongoServer|at run/);
});
