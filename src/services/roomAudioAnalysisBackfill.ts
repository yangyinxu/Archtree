import type { RoomAudioAnalysisInput, RoomAudioAnalysisItem, RoomAudioAnalysisOutcome, RoomAudioAnalysisPage,
    RoomAudioAnalysisReason } from '../contracts/roomAudioAnalysis';
import { knownRoomAudioAnalysisReason, verifyRoomAudioAnalysisPage } from './roomAudioAnalysisBatch';

/** Typed by the operator to permit writes; distinct from the single-page CLI so neither command's token unlocks the other. */
export const ROOM_AUDIO_BACKFILL_CONFIRMATION = 'BACKFILL_ROOM_AUDIO';

export interface RoomAudioBackfillOptions {
    actorId: string;
    apply: boolean;
    /** Resume strictly after this track ID, as printed in a previous run's resumeAfter. */
    after?: string;
    pageSize: number;
    /** Upper bound on analysis dispatches (or would-analyze rows in a dry run) for one invocation. */
    maxAnalyses: number;
    /** Pause between analysis dispatches, pacing S3 egress, database operations and local CPU. */
    delayMs: number;
    logPath?: string;
}

/** Listed sources that are skipped never cost a download; candidates are analyzed or previewed. */
export type RoomAudioBackfillResult = 'skipped' | 'wouldAnalyze' | RoomAudioAnalysisOutcome['outcome'];

/** One per-track log line; titles, source revisions, attempt IDs and storage keys stay out of it. */
export interface RoomAudioBackfillEntry {
    type: 'track';
    mediaTrackId: string;
    listed: RoomAudioAnalysisItem['status'];
    result: RoomAudioBackfillResult;
    reason: RoomAudioAnalysisReason | null;
    /** The cursor that safely continues after this row; null means start from the beginning. */
    resumeAfter: string | null;
}

export type RoomAudioBackfillStopReason = 'limit' | 'cancelled' | 'unknown' | 'failed'
    | 'decoder_unavailable' | 'storage_unavailable';

export interface RoomAudioBackfillSummary {
    type: 'summary';
    dryRun: boolean;
    finished: boolean;
    stopped: boolean;
    stopReason: RoomAudioBackfillStopReason | null;
    resumeAfter: string | null;
    listed: number;
    analyses: number;
    /** Rows passed over in this run that a later run started without --after retries. */
    retryLater: number;
    counts: Partial<Record<RoomAudioBackfillResult, number>>;
}

export interface RoomAudioBackfillDependencies {
    list: (input: { actorId: string; after?: string; limit?: number }) => Promise<RoomAudioAnalysisPage>;
    analyze: (input: RoomAudioAnalysisInput) => Promise<RoomAudioAnalysisOutcome>;
    /** Persists one result before the run moves on; a thrown write ends the run. */
    record: (entry: RoomAudioBackfillEntry) => Promise<void> | void;
    /** Pacing pause that returns early, without throwing, when the signal aborts. */
    sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

const id = /^[0-9a-f]{24}$/;
const sourceRevision = /^[0-9a-f]{64}$/;
const attemptId = /^[0-9a-f]{32}$/;
const usage = 'Use --admin-id=<24 lowercase hex>, optional --after=<24 lowercase hex>, --page-size=1..100, '
    + '--max-analyses=1..1000, --delay-ms=0..60000 and --log=<file>. Apply requires --apply --confirm='
    + `${ROOM_AUDIO_BACKFILL_CONFIRMATION}.`;

/** A fixed message keeps invalid CLI values and connection details out of command output. */
export class RoomAudioBackfillArgumentError extends Error {
    constructor() { super(usage); this.name = 'RoomAudioBackfillArgumentError'; }
}

const boundedInteger = (text: string | undefined, fallback: number, minimum: number, maximum: number) => {
    if (text === undefined) return fallback;
    if (!/^(?:0|[1-9][0-9]{0,5})$/.test(text)) throw new RoomAudioBackfillArgumentError();
    const value = Number(text);
    if (value < minimum || value > maximum) throw new RoomAudioBackfillArgumentError();
    return value;
};

/** Dry-run by default; rejects unknown, duplicate or ambiguous arguments and an apply without its exact confirmation. */
export const parseRoomAudioBackfillArguments = (args: readonly string[]): RoomAudioBackfillOptions => {
    const names = ['--admin-id', '--after', '--page-size', '--max-analyses', '--delay-ms', '--log', '--apply', '--confirm'];
    const fields = new Map<string, string>();
    for (const argument of args) {
        const separator = argument.indexOf('=');
        const name = separator < 0 ? argument : argument.slice(0, separator);
        const value = separator < 0 ? '' : argument.slice(separator + 1);
        if (!names.includes(name) || fields.has(name)
            || (name === '--apply' ? separator >= 0 : separator < 0 || !value)) throw new RoomAudioBackfillArgumentError();
        fields.set(name, value);
    }
    const actorId = fields.get('--admin-id') ?? '';
    const after = fields.get('--after');
    const logPath = fields.get('--log');
    const apply = fields.has('--apply');
    if (!id.test(actorId) || after !== undefined && !id.test(after)
        || logPath !== undefined && (logPath.length > 4096 || logPath.includes('\0'))
        || (apply ? fields.get('--confirm') !== ROOM_AUDIO_BACKFILL_CONFIRMATION : fields.has('--confirm'))) {
        throw new RoomAudioBackfillArgumentError();
    }
    return {
        actorId, apply,
        pageSize: boundedInteger(fields.get('--page-size'), 25, 1, 100),
        maxAnalyses: boundedInteger(fields.get('--max-analyses'), 100, 1, 1000),
        delayMs: boundedInteger(fields.get('--delay-ms'), 2000, 0, 60_000),
        ...(after ? { after } : {}), ...(logPath ? { logPath } : {})
    };
};

/**
 * Outcomes after which the next source would fail the same way: a missing or incapable local
 * decoder, or unavailable storage. Stopping avoids downloading every remaining source for nothing.
 */
const systemicFailures = new Set<RoomAudioAnalysisReason>(['decoder_unavailable', 'storage_unavailable']);
/** Per-source failures that leave the source retryable without implicating the next one. */
const perSourceFailures = new Set<RoomAudioAnalysisReason>(['analysis_timeout', 'analysis_failed']);

/**
 * Walks the whole catalog page by page and analyzes, one at a time, every ready/published Audio
 * source that lacks a current verified result (listed as notAnalyzed or retryable). Eligible,
 * terminally unsupported, unavailable and leased sources are skipped without storage reads, so
 * repeating a completed run analyzes nothing. Results come from the same source-fenced service as
 * the administrator page, which reuses a recorded attempt identity rather than starting new work.
 *
 * Busy, stale and per-source failures are logged and passed over (a later run retries them);
 * systemic failures, uncertain outcomes and cancellation stop before the cursor passes that row.
 */
export const runRoomAudioAnalysisBackfill = async (
    options: RoomAudioBackfillOptions,
    dependencies: RoomAudioBackfillDependencies,
    signal?: AbortSignal
): Promise<RoomAudioBackfillSummary> => {
    if (!id.test(options.actorId) || typeof options.apply !== 'boolean' || options.after !== undefined && !id.test(options.after)
        || !Number.isInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > 100
        || !Number.isInteger(options.maxAnalyses) || options.maxAnalyses < 1 || options.maxAnalyses > 1000
        || !Number.isInteger(options.delayMs) || options.delayMs < 0 || options.delayMs > 60_000) {
        throw new RoomAudioBackfillArgumentError();
    }
    const summary: RoomAudioBackfillSummary = {
        type: 'summary', dryRun: !options.apply, finished: false, stopped: false, stopReason: null,
        resumeAfter: options.after ?? null, listed: 0, analyses: 0, retryLater: 0, counts: {}
    };
    let safeAfter = options.after ?? null;
    const stop = (reason: RoomAudioBackfillStopReason) => {
        summary.stopped = true;
        summary.stopReason = reason;
        summary.resumeAfter = safeAfter;
        return summary;
    };
    const record = async (item: RoomAudioAnalysisItem, result: RoomAudioBackfillResult, reason: RoomAudioAnalysisReason | null,
        handled: boolean) => {
        if (handled) safeAfter = item.mediaTrackId;
        summary.counts[result] = (summary.counts[result] ?? 0) + 1;
        await dependencies.record({ type: 'track', mediaTrackId: item.mediaTrackId, listed: item.status, result,
            reason: knownRoomAudioAnalysisReason(reason), resumeAfter: safeAfter });
    };

    let after = options.after;
    for (;;) {
        if (signal?.aborted) return stop('cancelled');
        const page = await dependencies.list({ actorId: options.actorId, after, limit: options.pageSize });
        verifyRoomAudioAnalysisPage(page, after, options.pageSize);
        if (signal?.aborted) return stop('cancelled');
        summary.listed += page.items.length;
        for (const item of page.items) {
            if (signal?.aborted) return stop('cancelled');
            if (item.status === 'eligible' || item.status === 'unsupported' || item.status === 'unavailable') {
                await record(item, 'skipped', item.reason, true);
                continue;
            }
            if (item.status === 'running') {
                // Another administrator's lease owns this source now; it is not ours to wait for or take over.
                summary.retryLater += 1;
                await record(item, 'busy', null, true);
                continue;
            }
            if ((item.status !== 'notAnalyzed' && item.status !== 'retryable')
                || !sourceRevision.test(item.sourceRevision) || !attemptId.test(item.attemptId)) {
                await record(item, 'unknown', null, false);
                return stop('unknown');
            }
            if (summary.analyses >= options.maxAnalyses) return stop('limit');
            if (!options.apply) {
                summary.analyses += 1;
                await record(item, 'wouldAnalyze', item.reason, true);
                continue;
            }
            if (summary.analyses > 0 && options.delayMs > 0) {
                await dependencies.sleep(options.delayMs, signal);
                if (signal?.aborted) return stop('cancelled');
            }
            summary.analyses += 1;
            let outcome: RoomAudioAnalysisOutcome;
            try {
                outcome = await dependencies.analyze({ actorId: options.actorId, mediaTrackId: item.mediaTrackId,
                    sourceRevision: item.sourceRevision, attemptId: item.attemptId, signal });
            } catch {
                // A thrown call cannot prove whether the attempt was persisted; recovery rereads its state.
                await record(item, 'unknown', null, false);
                return stop('unknown');
            }
            if (outcome.mediaTrackId !== item.mediaTrackId || outcome.attemptId !== item.attemptId) {
                await record(item, 'unknown', null, false);
                return stop('unknown');
            }
            const reason = knownRoomAudioAnalysisReason(outcome.reason);
            switch (outcome.outcome) {
                case 'complete':
                case 'unsupported':
                    await record(item, outcome.outcome, reason, true);
                    break;
                case 'busy':
                case 'stale':
                    summary.retryLater += 1;
                    await record(item, outcome.outcome, reason, true);
                    break;
                case 'failed':
                    if (reason && perSourceFailures.has(reason)) {
                        summary.retryLater += 1;
                        await record(item, 'failed', reason, true);
                        break;
                    }
                    await record(item, 'failed', reason, false);
                    return stop(reason && systemicFailures.has(reason) ? reason as RoomAudioBackfillStopReason : 'failed');
                case 'cancelled':
                    await record(item, 'cancelled', reason, false);
                    return stop('cancelled');
                default:
                    await record(item, 'unknown', null, false);
                    return stop('unknown');
            }
        }
        if (page.nextAfter === null) {
            summary.finished = true;
            summary.resumeAfter = null;
            return summary;
        }
        // The scanned cursor can pass filtered Video rows that never appear as items.
        safeAfter = page.nextAfter;
        summary.resumeAfter = safeAfter;
        after = page.nextAfter;
    }
};
