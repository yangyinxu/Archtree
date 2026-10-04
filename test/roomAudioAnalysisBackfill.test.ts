import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { RoomAudioAnalysisInput, RoomAudioAnalysisItem, RoomAudioAnalysisOutcome, RoomAudioAnalysisPage,
    RoomAudioAnalysisReason } from '../src/contracts/roomAudioAnalysis';
import { parseRoomAudioBackfillArguments, RoomAudioBackfillArgumentError, runRoomAudioAnalysisBackfill,
    type RoomAudioBackfillDependencies, type RoomAudioBackfillEntry, type RoomAudioBackfillOptions } from '../src/services/roomAudioAnalysisBackfill';

const actorId = 'a'.repeat(24);
const rowId = (index: number) => index.toString(16).padStart(24, '0');
const item = (index: number, status: RoomAudioAnalysisItem['status'] = 'notAnalyzed',
    reason: RoomAudioAnalysisReason | null = null): RoomAudioAnalysisItem => ({
    mediaTrackId: rowId(index), title: 'Private title must stay out of backfill output', status,
    sourceRevision: 'b'.repeat(64), attemptId: index.toString(16).padStart(32, '0'), updatedAt: null, reason
});
const options: RoomAudioBackfillOptions = { actorId, apply: true, pageSize: 3, maxAnalyses: 100, delayMs: 0 };

/** A synthetic catalog that pages like the service: ascending IDs, a scanned cursor and analysis state that persists. */
const catalog = (rows: RoomAudioAnalysisItem[], outcomeFor: (row: RoomAudioAnalysisItem) => RoomAudioAnalysisOutcome['outcome'] = () => 'complete',
    reasonFor: (row: RoomAudioAnalysisItem) => RoomAudioAnalysisReason | null = () => null) => {
    const state = new Map(rows.map(row => [row.mediaTrackId, { ...row }]));
    const analyzed: RoomAudioAnalysisInput[] = [];
    const entries: RoomAudioBackfillEntry[] = [];
    const sleeps: number[] = [];
    const lists: Array<string | undefined> = [];
    const dependencies: RoomAudioBackfillDependencies = {
        list: async ({ after, limit = 25 }): Promise<RoomAudioAnalysisPage> => {
            lists.push(after);
            const remaining = [...state.values()].filter(row => row.mediaTrackId > (after ?? '')).sort((a, b) => a.mediaTrackId.localeCompare(b.mediaTrackId));
            const page = remaining.slice(0, limit);
            return { items: page.map(row => ({ ...row })), nextAfter: remaining.length > limit ? page[limit - 1].mediaTrackId : null };
        },
        analyze: async input => {
            analyzed.push(input);
            const row = state.get(input.mediaTrackId)!;
            const outcome = outcomeFor(row);
            if (outcome === 'complete') row.status = 'eligible';
            if (outcome === 'unsupported') row.status = 'unsupported';
            return { mediaTrackId: input.mediaTrackId, attemptId: input.attemptId, outcome, reason: reasonFor(row) };
        },
        record: entry => { entries.push(entry); },
        sleep: async milliseconds => { sleeps.push(milliseconds); }
    };
    return { dependencies, analyzed, entries, sleeps, lists, state };
};

test('argument parsing defaults to a paced dry run and requires the exact backfill confirmation to write', () => {
    assert.deepEqual(parseRoomAudioBackfillArguments([`--admin-id=${actorId}`]),
        { actorId, apply: false, pageSize: 25, maxAnalyses: 100, delayMs: 2000 });
    assert.deepEqual(parseRoomAudioBackfillArguments([`--admin-id=${actorId}`, `--after=${rowId(9)}`, '--page-size=100',
        '--max-analyses=1000', '--delay-ms=0', '--log=backfill.jsonl', '--apply', '--confirm=BACKFILL_ROOM_AUDIO']),
    { actorId, apply: true, pageSize: 100, maxAnalyses: 1000, delayMs: 0, after: rowId(9), logPath: 'backfill.jsonl' });
    for (const args of [
        [], ['--admin-id=bad'], [`--admin-id=${actorId}`, `--admin-id=${actorId}`], [`--admin-id=${actorId}`, '--after=bad'],
        [`--admin-id=${actorId}`, '--page-size=0'], [`--admin-id=${actorId}`, '--page-size=101'], [`--admin-id=${actorId}`, '--page-size=01'],
        [`--admin-id=${actorId}`, '--max-analyses=0'], [`--admin-id=${actorId}`, '--max-analyses=1001'],
        [`--admin-id=${actorId}`, '--delay-ms=-1'], [`--admin-id=${actorId}`, '--delay-ms=60001'], [`--admin-id=${actorId}`, '--delay-ms=1.5'],
        [`--admin-id=${actorId}`, '--log='], [`--admin-id=${actorId}`, '--log'], [`--admin-id=${actorId}`, '--apply'],
        [`--admin-id=${actorId}`, '--apply=true', '--confirm=BACKFILL_ROOM_AUDIO'],
        [`--admin-id=${actorId}`, '--apply', '--confirm=ANALYZE_ROOM_AUDIO'],
        [`--admin-id=${actorId}`, '--confirm=BACKFILL_ROOM_AUDIO'],
        [`--admin-id=${actorId}`, '--unexpected=private-value']
    ]) assert.throws(() => parseRoomAudioBackfillArguments(args), RoomAudioBackfillArgumentError, args.join(' '));
});

test('a dry run walks every page, selects only sources lacking current analysis and never analyzes or pauses', async () => {
    const fixture = catalog([item(1, 'eligible'), item(2), item(3, 'unsupported', 'unsupported_audio'), item(4, 'retryable', 'decoder_unavailable'),
        item(5, 'unavailable'), item(6, 'running'), item(7)]);
    const summary = await runRoomAudioAnalysisBackfill({ ...options, apply: false, delayMs: 5000 }, fixture.dependencies);
    assert.deepEqual(fixture.analyzed, []);
    assert.deepEqual(fixture.sleeps, []);
    assert.deepEqual(fixture.lists, [undefined, rowId(3), rowId(6)]);
    assert.deepEqual(fixture.entries.map(entry => [entry.mediaTrackId, entry.result]), [
        [rowId(1), 'skipped'], [rowId(2), 'wouldAnalyze'], [rowId(3), 'skipped'], [rowId(4), 'wouldAnalyze'],
        [rowId(5), 'skipped'], [rowId(6), 'busy'], [rowId(7), 'wouldAnalyze']
    ]);
    assert.equal(fixture.entries[3].reason, 'decoder_unavailable');
    assert.deepEqual({ ...summary, counts: undefined }, { type: 'summary', dryRun: true, finished: true, stopped: false, stopReason: null,
        resumeAfter: null, listed: 7, analyses: 3, retryLater: 1, counts: undefined });
    assert.doesNotMatch(JSON.stringify([fixture.entries, summary]), /Private|title|sourceRevision|attemptId|b{64}/);
});

test('apply analyzes candidates one at a time with the listed identity and pauses only between analyses', async () => {
    let active = false;
    const fixture = catalog([item(1, 'eligible'), item(2), item(3, 'retryable', 'interrupted'), item(4), item(5, 'unsupported')]);
    const analyze = fixture.dependencies.analyze;
    fixture.dependencies.analyze = async input => {
        assert.equal(active, false, 'analyses never overlap');
        active = true;
        await new Promise(resolve => setImmediate(resolve));
        try { return await analyze(input); } finally { active = false; }
    };
    const summary = await runRoomAudioAnalysisBackfill({ ...options, delayMs: 1500 }, fixture.dependencies);
    assert.deepEqual(fixture.analyzed.map(input => [input.mediaTrackId, input.attemptId, input.sourceRevision, input.actorId]),
        [2, 3, 4].map(index => [rowId(index), item(index).attemptId, 'b'.repeat(64), actorId]));
    assert.deepEqual(fixture.sleeps, [1500, 1500]);
    assert.equal(summary.finished, true);
    assert.deepEqual(summary.counts, { skipped: 2, complete: 3 });
});

test('a completed backfill is idempotent: rerunning finds nothing to analyze', async () => {
    const fixture = catalog([item(1), item(2, 'retryable', 'decoder_unavailable'), item(3, 'eligible'), item(4)],
        row => row.mediaTrackId === rowId(4) ? 'unsupported' : 'complete');
    const first = await runRoomAudioAnalysisBackfill(options, fixture.dependencies);
    assert.deepEqual(first.counts, { complete: 2, skipped: 1, unsupported: 1 });
    const analyses = fixture.analyzed.length;
    const second = await runRoomAudioAnalysisBackfill(options, fixture.dependencies);
    assert.equal(fixture.analyzed.length, analyses);
    assert.deepEqual(second.counts, { skipped: 4 });
    assert.equal(second.analyses, 0);
    assert.equal(second.finished, true);
});

test('busy, stale and per-source failures are logged and passed over for a later run', async () => {
    const outcomes: Record<string, [RoomAudioAnalysisOutcome['outcome'], RoomAudioAnalysisReason | null]> = {
        [rowId(1)]: ['busy', null], [rowId(2)]: ['stale', 'source_changed'], [rowId(3)]: ['failed', 'analysis_timeout'],
        [rowId(4)]: ['failed', 'analysis_failed'], [rowId(5)]: ['complete', null]
    };
    const fixture = catalog([1, 2, 3, 4, 5].map(index => item(index)), row => outcomes[row.mediaTrackId][0], row => outcomes[row.mediaTrackId][1]);
    const summary = await runRoomAudioAnalysisBackfill(options, fixture.dependencies);
    assert.equal(fixture.analyzed.length, 5);
    assert.equal(summary.finished, true);
    assert.equal(summary.retryLater, 4);
    assert.deepEqual(fixture.entries.map(entry => [entry.result, entry.reason, entry.resumeAfter]), [
        ['busy', null, rowId(1)], ['stale', 'source_changed', rowId(2)], ['failed', 'analysis_timeout', rowId(3)],
        ['failed', 'analysis_failed', rowId(4)], ['complete', null, rowId(5)]
    ]);
});

test('systemic failures, uncertain outcomes and cancellation stop before the cursor passes the row', async () => {
    const cases: Array<[RoomAudioAnalysisOutcome['outcome'] | 'throw' | 'mismatch', RoomAudioAnalysisReason | null, string]> = [
        ['failed', 'decoder_unavailable', 'decoder_unavailable'], ['failed', 'storage_unavailable', 'storage_unavailable'],
        ['failed', null, 'failed'], ['cancelled', 'cancelled', 'cancelled'], ['unknown', null, 'unknown'],
        ['throw', null, 'unknown'], ['mismatch', null, 'unknown']
    ];
    for (const [outcome, reason, stopReason] of cases) {
        const fixture = catalog([item(1, 'eligible'), item(2), item(3), item(4)]);
        fixture.dependencies.analyze = async input => {
            fixture.analyzed.push(input);
            if (outcome === 'throw') throw new Error('private storage response');
            if (outcome === 'mismatch') return { mediaTrackId: rowId(9), attemptId: input.attemptId, outcome: 'complete', reason: null };
            return { mediaTrackId: input.mediaTrackId, attemptId: input.attemptId, outcome, reason };
        };
        const summary = await runRoomAudioAnalysisBackfill(options, fixture.dependencies);
        assert.equal(fixture.analyzed.length, 1, stopReason);
        assert.equal(summary.stopped, true);
        assert.equal(summary.stopReason, stopReason);
        assert.equal(summary.resumeAfter, rowId(1), 'resuming rereads the unresolved row');
        const last = fixture.entries[fixture.entries.length - 1];
        assert.equal(last.mediaTrackId, rowId(2));
        assert.equal(last.resumeAfter, rowId(1));
        assert.doesNotMatch(JSON.stringify(fixture.entries), /private storage response/);
    }
});

test('the analysis cap stops at the next candidate and an explicit resume continues exactly there', async () => {
    const fixture = catalog([item(1), item(2, 'eligible'), item(3), item(4), item(5, 'eligible'), item(6)]);
    const first = await runRoomAudioAnalysisBackfill({ ...options, maxAnalyses: 2 }, fixture.dependencies);
    assert.equal(first.stopReason, 'limit');
    assert.equal(first.resumeAfter, rowId(3));
    assert.deepEqual(fixture.analyzed.map(input => input.mediaTrackId), [rowId(1), rowId(3)]);
    const second = await runRoomAudioAnalysisBackfill({ ...options, maxAnalyses: 2, after: first.resumeAfter! }, fixture.dependencies);
    assert.equal(second.finished, true);
    assert.deepEqual(fixture.analyzed.map(input => input.mediaTrackId), [rowId(1), rowId(3), rowId(4), rowId(6)]);
    assert.equal(fixture.lists[2], rowId(3), 'the resumed scan starts strictly after the reported cursor');

    const trailing = catalog([item(1), item(2, 'eligible')]);
    const exact = await runRoomAudioAnalysisBackfill({ ...options, maxAnalyses: 1 }, trailing.dependencies);
    assert.equal(exact.finished, true, 'reaching the cap with no candidate left still finishes the scan');
});

test('cancellation while a filtered page loads keeps the previous cursor', async () => {
    const controller = new AbortController();
    const fixture = catalog([]);
    fixture.dependencies.list = async () => { controller.abort(); return { items: [], nextAfter: rowId(5) }; };
    const summary = await runRoomAudioAnalysisBackfill({ ...options, after: rowId(1) }, fixture.dependencies, controller.signal);
    assert.equal(summary.stopReason, 'cancelled');
    assert.equal(summary.resumeAfter, rowId(1));
});

test('cancellation during the pacing pause stops without dispatching the next analysis', async () => {
    const controller = new AbortController();
    const fixture = catalog([item(1), item(2), item(3)]);
    fixture.dependencies.sleep = async () => { controller.abort(); };
    const summary = await runRoomAudioAnalysisBackfill({ ...options, delayMs: 10 }, fixture.dependencies, controller.signal);
    assert.equal(summary.stopReason, 'cancelled');
    assert.equal(summary.resumeAfter, rowId(1));
    assert.equal(fixture.analyzed.length, 1);
});

test('malformed listings, unknown statuses and failed log writes never advance or continue silently', async () => {
    const malformed = catalog([item(1)]);
    malformed.dependencies.list = async () => ({ items: [item(2), item(1)], nextAfter: null });
    await assert.rejects(runRoomAudioAnalysisBackfill(options, malformed.dependencies), /could not be verified/);
    assert.deepEqual(malformed.analyzed, []);

    const unknown = catalog([item(1, 'eligible'), { ...item(2), status: 'mystery' as RoomAudioAnalysisItem['status'] }, item(3)]);
    const stopped = await runRoomAudioAnalysisBackfill(options, unknown.dependencies);
    assert.equal(stopped.stopReason, 'unknown');
    assert.equal(stopped.resumeAfter, rowId(1));
    assert.deepEqual(unknown.analyzed, []);

    const unwritable = catalog([item(1), item(2)]);
    unwritable.dependencies.record = () => { throw new Error('disk full'); };
    await assert.rejects(runRoomAudioAnalysisBackfill(options, unwritable.dependencies), /disk full/);
    assert.equal(unwritable.analyzed.length, 1, 'no further work starts once a result cannot be logged');

    await assert.rejects(runRoomAudioAnalysisBackfill({ ...options, delayMs: 60_001 }, catalog([]).dependencies), RoomAudioBackfillArgumentError);
});

/** Runs the documented entry point with a database that is never reachable; these failures must precede any connection. */
const runCli = (args: string[], environment: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath,
    ['--import', 'tsx', fileURLToPath(new URL('../scripts/backfill-room-audio-analysis.ts', import.meta.url)), ...args], {
        cwd: fileURLToPath(new URL('..', import.meta.url)), timeout: 15_000, encoding: 'utf8',
        env: { ...process.env, DB_CONN_STRING: 'mongodb://127.0.0.1:1/private-fixture', DB_NAME: 'private-fixture', ...environment }
    });

test('the CLI rejects invalid arguments before connecting and never echoes them', () => {
    const result = runCli(['--unexpected=private-command-input']);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Use --admin-id/);
    assert.doesNotMatch(result.stderr, /private-command-input|private-fixture|MongoServer|at run/);
});

test('apply refuses to start without a capable local decoder, before opening the log or the database', () => {
    const directory = mkdtempSync(join(tmpdir(), 'archtree-backfill-preflight-'));
    try {
        const log = join(directory, 'backfill.jsonl');
        const result = runCli([`--admin-id=${actorId}`, `--log=${log}`, '--apply', '--confirm=BACKFILL_ROOM_AUDIO'],
            { ROOM_AUDIO_FFMPEG_PATH: join(directory, 'missing-ffmpeg') });
        assert.equal(result.status, 1);
        assert.equal(result.stdout, '');
        assert.match(result.stderr, /^Room audio decoder is unavailable\./);
        assert.doesNotMatch(result.stderr, /private-fixture|missing-ffmpeg|MongoServer/);
        assert.equal(existsSync(log), false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
});
