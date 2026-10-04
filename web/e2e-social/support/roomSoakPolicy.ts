import { SOCIAL_LIMITS } from '../../../src/contracts/socialV1';

/** Reloads consume new page-scoped mutation capabilities; preserve the real daily issuance budget. */
export const ROOM_SOAK_MAX_DEVICE_RECOVERIES = Math.min(16, SOCIAL_LIMITS.scopesPerDay - 3);

export type RoomSoakAdmissionReason = 'concurrency' | 'request-window' | 'media-concurrency' | 'other';

/** Reduces untrusted denial bodies to fixed labels; private fields and unexpected messages never enter evidence. */
export const roomSoakAdmissionReason = (body: unknown): RoomSoakAdmissionReason => {
    const message = body && typeof body === 'object' && !Array.isArray(body) && 'message' in body ? body.message : undefined;
    return message === 'Too many concurrent requests.' ? 'concurrency'
        : message === 'Too many concurrent media requests.' ? 'media-concurrency'
            : message === 'Too many requests. Please try again later.' ? 'request-window' : 'other';
};

export interface RoomSoakCommandDiagnostic {
    status: number; outcome?: string; code?: string; admissionReason?: RoomSoakAdmissionReason;
}

/** Owns one bounded command diagnostic; a delayed former response cannot overwrite the latest observation. */
export const createRoomSoakCommandDiagnostic = () => {
    let sequence = 0;
    let current: RoomSoakCommandDiagnostic | undefined;
    return {
        async record(status: number, readBody: () => Promise<unknown>) {
            const observed = ++sequence;
            const body = await readBody().catch(() => undefined);
            if (observed !== sequence) return;
            const fields = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : undefined;
            current = { status,
                outcome: typeof fields?.outcome === 'string' && ['applied', 'rejected', 'noop'].includes(fields.outcome) ? fields.outcome : undefined,
                code: typeof fields?.code === 'string' && ['rate_limited', 'capacity_exceeded', 'stale_control', 'conflict', 'rooms_disabled'].includes(fields.code)
                    ? fields.code : undefined,
                admissionReason: status === 429 ? roomSoakAdmissionReason(body) : undefined };
        },
        snapshot: () => current && { ...current }
    };
};

/** Measures only the entered playback period using the runner's monotonic clock. */
export const roomSoakElapsedSeconds = (startedAtMs: number | null, nowMs: number): number | null => {
    if (startedAtMs === null) return null;
    if (!Number.isFinite(startedAtMs) || startedAtMs < 0 || !Number.isFinite(nowMs) || nowMs < startedAtMs) {
        throw new Error('Room soak elapsed time requires an ordered finite monotonic clock.');
    }
    return (nowMs - startedAtMs) / 1000;
};

/** Uses a participant's published request-window headroom before another explicit gesture; never replays a denied command. */
export const roomSoakWindowAdmissionAt = (headers: Record<string, string>, now: number, participants: number): number => {
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(participants) || participants < 2 || participants > 8) return 0;
    const limit = headers['ratelimit-limit'], remaining = headers['ratelimit-remaining'], reset = headers['ratelimit-reset'];
    if (!['120', '180'].includes(limit) || !/^(?:0|[1-9]\d{0,2})$/.test(remaining ?? '')
        || !/^[1-9]\d{0,15}$/.test(reset ?? '')) return 0;
    const available = Number(remaining), resetAt = Number(reset) * 1000;
    // The server rounds epoch seconds upward; one minute of admission can therefore span at most 61 seconds here.
    if (available > participants || available > Number(limit) || !Number.isSafeInteger(resetAt)
        || resetAt <= now || resetAt - now > 61_000) return 0;
    return resetAt;
};

/** Bounds the isolated room soak; these values do not authorize a remote load target. */
export interface RoomSoakOptions {
    durationSeconds: number;
    cycleSeconds: number;
    members: number;
}

const readInteger = (
    env: Record<string, string | undefined>,
    name: string,
    fallback: number,
    minimum: number,
    maximum: number
) => {
    const value = env[name];
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
        throw new Error(`${name} must be a bounded positive decimal integer.`);
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
        throw new Error(`${name} is outside its permitted range.`);
    }
    return parsed;
};

/** Rejects coercions and incomplete overrides before any browser or fixture starts. */
export const readRoomSoakOptions = (
    env: Record<string, string | undefined> = process.env
): RoomSoakOptions => {
    const durationSeconds = readInteger(env, 'FINITUDE_ROOM_SOAK_SECONDS', 1_800, 60, 28_800);
    const cycleSeconds = readInteger(env, 'FINITUDE_ROOM_SOAK_CYCLE_SECONDS', 45, 15, 300);
    const members = readInteger(env, 'FINITUDE_ROOM_SOAK_MEMBERS', 2, 2, 8);
    if (cycleSeconds > durationSeconds) {
        throw new Error('FINITUDE_ROOM_SOAK_CYCLE_SECONDS must not exceed FINITUDE_ROOM_SOAK_SECONDS.');
    }
    // A three-cycle round sends three host controls; reserve seeded relationships, setup, partial rounds, and End.
    if (Math.ceil(durationSeconds / cycleSeconds) + 2 * members + 4 >= SOCIAL_LIMITS.receipts) {
        throw new Error('Room soak duration and cycle spacing would exceed the real retained mutation budget. Increase cycle spacing.');
    }
    return { durationSeconds, cycleSeconds, members };
};

/** The sampler supplies measured scalars only; no identity, URL or exception enters the DTO. */
export interface RoomSoakSample {
    rssBytes: number;
    heapUsedBytes: number;
    activeUpgradeTransports: number;
    activeStreams: number;
    driftMs?: number;
    /** Preparation/recovery samples do not establish steady playback alignment. */
    driftConverging?: boolean;
}

export interface RoomSoakMetricSummary {
    sampleCount: number;
    start: number | null;
    end: number | null;
    min: number | null;
    max: number | null;
}

export interface RoomSoakSummarySnapshot {
    sampleCount: number;
    rssBytes: RoomSoakMetricSummary;
    heapUsedBytes: RoomSoakMetricSummary;
    activeUpgradeTransports: RoomSoakMetricSummary;
    activeStreams: RoomSoakMetricSummary;
    /** Absolute drift in milliseconds, excluding samples explicitly marked as converging. */
    driftMs: RoomSoakMetricSummary & { convergenceExclusions: number };
}

const emptyMetric = (): RoomSoakMetricSummary => ({ sampleCount: 0, start: null, end: null, min: null, max: null });

const observe = (metric: RoomSoakMetricSummary, value: number) => {
    metric.sampleCount += 1;
    metric.start ??= value;
    metric.end = value;
    metric.min = metric.min === null ? value : Math.min(metric.min, value);
    metric.max = metric.max === null ? value : Math.max(metric.max, value);
};

/** Keeps constant-size online aggregates; invalid samples leave every accumulator unchanged. */
export const createRoomSoakSummary = () => {
    const metrics = {
        rssBytes: emptyMetric(), heapUsedBytes: emptyMetric(),
        activeUpgradeTransports: emptyMetric(), activeStreams: emptyMetric(), driftMs: emptyMetric()
    };
    let sampleCount = 0;
    let convergenceExclusions = 0;
    return {
        record(sample: RoomSoakSample) {
            for (const key of ['rssBytes', 'heapUsedBytes', 'activeUpgradeTransports', 'activeStreams'] as const) {
                if (!Number.isSafeInteger(sample[key]) || sample[key] < 0) {
                    throw new Error(`Room soak ${key} must be a non-negative safe integer.`);
                }
            }
            if (sample.driftMs !== undefined && (typeof sample.driftMs !== 'number' || !Number.isFinite(sample.driftMs))) {
                throw new Error('Room soak driftMs must be finite.');
            }
            if (sample.driftConverging !== undefined && typeof sample.driftConverging !== 'boolean') {
                throw new Error('Room soak driftConverging must be boolean.');
            }
            sampleCount += 1;
            observe(metrics.rssBytes, sample.rssBytes);
            observe(metrics.heapUsedBytes, sample.heapUsedBytes);
            observe(metrics.activeUpgradeTransports, sample.activeUpgradeTransports);
            observe(metrics.activeStreams, sample.activeStreams);
            if (sample.driftMs !== undefined) {
                if (sample.driftConverging) convergenceExclusions += 1;
                else observe(metrics.driftMs, Math.abs(sample.driftMs));
            }
        },
        snapshot(): RoomSoakSummarySnapshot {
            return {
                sampleCount,
                rssBytes: { ...metrics.rssBytes }, heapUsedBytes: { ...metrics.heapUsedBytes },
                activeUpgradeTransports: { ...metrics.activeUpgradeTransports }, activeStreams: { ...metrics.activeStreams },
                driftMs: { ...metrics.driftMs, convergenceExclusions }
            };
        }
    };
};
