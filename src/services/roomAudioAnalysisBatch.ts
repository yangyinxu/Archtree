import type { RoomAudioAnalysisInput, RoomAudioAnalysisOutcome, RoomAudioAnalysisPage, RoomAudioAnalysisReason } from '../contracts/roomAudioAnalysis';

export interface RoomAudioAnalysisBatchOptions {
    actorId: string;
    apply: boolean;
    limit: number;
    after?: string;
}

export interface RoomAudioAnalysisBatchDependencies {
    list: (input: { actorId: string; after?: string; limit?: number }) => Promise<RoomAudioAnalysisPage>;
    analyze: (input: RoomAudioAnalysisInput) => Promise<RoomAudioAnalysisOutcome>;
}

type BatchOutcome = RoomAudioAnalysisOutcome['outcome'] | 'wouldAnalyze' | 'alreadyEligible' | 'unavailable';
type StopReason = 'busy' | 'unknown' | 'failed' | 'cancelled' | 'stale';
export interface RoomAudioAnalysisBatchReport {
    dryRun: boolean;
    limit: number;
    listedCount: number;
    stopped: boolean;
    stopReason: StopReason | null;
    resumeAfter: string | null;
    nextAfter: string | null;
    counts: Partial<Record<BatchOutcome, number>>;
    results: Array<{ mediaTrackId: string; outcome: BatchOutcome; reason: RoomAudioAnalysisReason | null }>;
}

const id = /^[0-9a-f]{24}$/;
const reasonValues = new Set<RoomAudioAnalysisReason>(['unsupported_audio', 'decoder_unavailable', 'analysis_timeout', 'analysis_failed', 'storage_unavailable', 'source_changed', 'cancelled', 'interrupted']);
const stopValues = new Set<StopReason>(['busy', 'unknown', 'failed', 'cancelled', 'stale']);

/** A fixed message keeps invalid CLI values and connection details out of command output. */
export class RoomAudioAnalysisArgumentError extends Error {
    constructor() {
        super('Use --admin-id=<24 lowercase hex>, optional --limit=1..100 and --after=<24 lowercase hex>. Apply requires --apply --confirm=ANALYZE_ROOM_AUDIO.');
    }
}

/** Requires one explicit administrator and rejects unknown, duplicate or ambiguous command arguments. */
export const parseRoomAudioAnalysisArguments = (args: readonly string[]): RoomAudioAnalysisBatchOptions => {
    const fields = new Map<string, string>();
    for (const argument of args) {
        const separator = argument.indexOf('=');
        const name = separator < 0 ? argument : argument.slice(0, separator);
        const value = separator < 0 ? '' : argument.slice(separator + 1);
        if (!['--admin-id', '--limit', '--after', '--apply', '--confirm'].includes(name)
            || fields.has(name) || (name === '--apply' ? separator >= 0 : separator < 0 || !value)) {
            throw new RoomAudioAnalysisArgumentError();
        }
        fields.set(name, value);
    }
    const actorId = fields.get('--admin-id') ?? '';
    const after = fields.get('--after');
    const limitText = fields.get('--limit') ?? '25';
    const apply = fields.has('--apply');
    if (!id.test(actorId) || after !== undefined && !id.test(after)
        || !/^(?:[1-9][0-9]?|100)$/.test(limitText)
        || (apply ? fields.get('--confirm') !== 'ANALYZE_ROOM_AUDIO' : fields.has('--confirm'))) {
        throw new RoomAudioAnalysisArgumentError();
    }
    return { actorId, apply, limit: Number(limitText), ...(after ? { after } : {}) };
};

/** Processes one sequential page; an unresolved item is never advanced past its recovery checkpoint. */
export const runRoomAudioAnalysisBatch = async (
    options: RoomAudioAnalysisBatchOptions,
    dependencies: RoomAudioAnalysisBatchDependencies,
    signal?: AbortSignal
): Promise<RoomAudioAnalysisBatchReport> => {
    if (!id.test(options.actorId) || typeof options.apply !== 'boolean' || !Number.isInteger(options.limit)
        || options.limit < 1 || options.limit > 100 || options.after !== undefined && !id.test(options.after)) {
        throw new RoomAudioAnalysisArgumentError();
    }
    const report: RoomAudioAnalysisBatchReport = {
        dryRun: !options.apply, limit: options.limit, listedCount: 0, stopped: false, stopReason: null,
        resumeAfter: options.after ?? null, nextAfter: null, counts: {}, results: []
    };
    let safeAfter = options.after ?? null;
    const stop = (reason: StopReason) => {
        report.stopped = true;
        report.stopReason = reason;
        report.resumeAfter = safeAfter;
        return report;
    };
    if (signal?.aborted) return stop('cancelled');
    const page = await dependencies.list({ actorId: options.actorId, after: options.after, limit: options.limit });
    let previousId = options.after ?? '';
    if (page.items.length > options.limit || page.items.some(item => {
        if (!id.test(item.mediaTrackId) || item.mediaTrackId <= previousId) return true;
        previousId = item.mediaTrackId;
        return false;
    }) || page.nextAfter !== null && (!id.test(page.nextAfter) || page.nextAfter < previousId
        || page.nextAfter <= (options.after ?? ''))) {
        throw new Error('The analysis page could not be verified.');
    }
    report.listedCount = page.items.length;
    report.nextAfter = page.nextAfter;
    if (signal?.aborted) return stop('cancelled');
    const record = (mediaTrackId: string, outcome: BatchOutcome, reason: RoomAudioAnalysisReason | null = null) => {
        report.results.push({ mediaTrackId, outcome, reason: reason && reasonValues.has(reason) ? reason : null });
        report.counts[outcome] = (report.counts[outcome] ?? 0) + 1;
    };
    for (const item of page.items) {
        if (signal?.aborted) return stop('cancelled');
        if (item.status === 'running') {
            record(item.mediaTrackId, 'busy');
            return stop('busy');
        }
        if (['eligible', 'unsupported', 'unavailable'].includes(item.status)) {
            record(item.mediaTrackId, item.status === 'eligible' ? 'alreadyEligible' : item.status as 'unsupported' | 'unavailable', item.reason);
        } else if (item.status === 'notAnalyzed' || item.status === 'retryable') {
            if (!/^[0-9a-f]{64}$/.test(item.sourceRevision) || !/^[0-9a-f]{32}$/.test(item.attemptId)) {
                record(item.mediaTrackId, 'unknown');
                return stop('unknown');
            }
            if (!options.apply) record(item.mediaTrackId, 'wouldAnalyze');
            else {
                let result: RoomAudioAnalysisOutcome | undefined;
                try {
                    result = await dependencies.analyze({
                        actorId: options.actorId, mediaTrackId: item.mediaTrackId,
                        sourceRevision: item.sourceRevision, attemptId: item.attemptId, signal
                    });
                } catch {
                    // A thrown response cannot prove that the persisted attempt failed or was cancelled.
                    record(item.mediaTrackId, 'unknown');
                    return stop('unknown');
                }
                const matches = result.mediaTrackId === item.mediaTrackId && result.attemptId === item.attemptId;
                const outcome = matches && (result.outcome === 'complete' || result.outcome === 'unsupported' || stopValues.has(result.outcome as StopReason))
                    ? result.outcome : 'unknown';
                record(item.mediaTrackId, outcome, result.reason);
                if (stopValues.has(outcome as StopReason)) return stop(outcome as StopReason);
            }
        } else {
            record(item.mediaTrackId, 'unknown');
            return stop('unknown');
        }
        safeAfter = item.mediaTrackId;
    }
    report.resumeAfter = page.nextAfter;
    return report;
};
