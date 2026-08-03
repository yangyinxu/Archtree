#!/usr/bin/env node

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_CLIENTS = 32;
const MAX_TOTAL_REQUESTS = 1_000;
const RANGE_SAMPLE_BYTES = 64 * 1024;
const HEALTH_RECOVERY_TIMEOUT_MS = 2_000;
const HEALTH_RECOVERY_INTERVAL_MS = 200;
export const ARTWORK_VARIANT_WIDTHS = Object.freeze([
    96,
    192,
    320,
    480,
    640,
    960,
    1280
]);

export const HELP = `Finitude media Range load check

Required:
  MEDIA_LOAD_TRACK_IDS          Comma-separated ready audio-track ObjectIds.

Target safety:
  MEDIA_LOAD_BASE_URL           Defaults to http://127.0.0.1:8081.
  ALLOW_REMOTE_MEDIA_LOAD=1     Required for every non-loopback target.
  MEDIA_LOAD_ALLOWED_HOSTS      Exact comma-separated hostname allowlist for remote targets.

Optional:
  MEDIA_LOAD_ARTWORK_IDS        Comma-separated public artwork ObjectIds.
  MEDIA_LOAD_CLIENTS            Concurrent listeners, default 4, maximum 32.
  MEDIA_LOAD_SEEK_CYCLES        Open-ended seek requests per listener, default 4.
  MEDIA_LOAD_ARTWORK_CONCURRENCY  Artwork workers, default 4, maximum 32.
  MEDIA_LOAD_REQUEST_TIMEOUT_MS Per-request timeout, default 10000, maximum 30000.
  MEDIA_LOAD_SEEK_DELAY_MS      Delay between seek replacements, default 75.
  MEDIA_LOAD_HEALTH_POLLS       Concurrent health samples, default 40, maximum 100.

The command emits one aggregate JSON object. It never prints target URLs,
content IDs, ETags, or Range values.`;

export class LoadConfigurationError extends Error {
    constructor(code) {
        super(code);
        this.name = 'LoadConfigurationError';
        this.code = code;
    }
}

export const parseCsv = (value) => [...new Set(
    String(value ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
)];

export const parseBoundedInteger = (value, fallback, minimum, maximum, errorCode) => {
    if (value === undefined || value === '') return fallback;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
        throw new LoadConfigurationError(errorCode);
    }
    return parsed;
};

/** Repeats supplied artwork IDs just enough to exercise the configured worker pool. */
export const buildArtworkWorkload = (artworkIds, concurrency) => {
    if (artworkIds.length === 0) return [];
    const requestCount = Math.max(
        artworkIds.length,
        concurrency,
        ARTWORK_VARIANT_WIDTHS.length
    );
    return Array.from(
        { length: requestCount },
        (_, index) => artworkIds[index % artworkIds.length]
    );
};

/** Selects a checked-in display width without exposing content identifiers in output. */
export const buildArtworkVariantPath = (artworkId, requestIndex) => {
    const width = ARTWORK_VARIANT_WIDTHS[requestIndex % ARTWORK_VARIANT_WIDTHS.length];
    return `/content/images/${encodeURIComponent(artworkId)}/v1/${width}.webp`;
};

const normalizeHostname = (hostname) => String(hostname ?? '')
    .trim()
    .toLowerCase()
    .replace(/^\[/, '')
    .replace(/\]$/, '');

export const isLoopbackHostname = (hostname) => {
    const normalized = normalizeHostname(hostname);
    if (normalized === 'localhost' || normalized === '::1') return true;
    if (!/^127(?:\.\d{1,3}){3}$/.test(normalized)) return false;
    return normalized.split('.').every((part) => Number(part) >= 0 && Number(part) <= 255);
};

/** Validates a target without resolving DNS or following a redirect. */
export const validateTargetPolicy = (baseUrlValue, env = process.env) => {
    let target;
    try {
        target = new URL(baseUrlValue);
    } catch {
        throw new LoadConfigurationError('MEDIA_LOAD_BASE_URL_INVALID');
    }
    if (!['http:', 'https:'].includes(target.protocol)
        || target.username || target.password
        || (target.pathname !== '/' && target.pathname !== '')
        || target.search || target.hash) {
        throw new LoadConfigurationError('MEDIA_LOAD_BASE_URL_INVALID');
    }

    if (!isLoopbackHostname(target.hostname)) {
        if (env.ALLOW_REMOTE_MEDIA_LOAD !== '1') {
            throw new LoadConfigurationError('REMOTE_MEDIA_LOAD_NOT_ALLOWED');
        }
        const allowedHosts = new Set(
            parseCsv(env.MEDIA_LOAD_ALLOWED_HOSTS).map(normalizeHostname)
        );
        if (!allowedHosts.has(normalizeHostname(target.hostname))) {
            throw new LoadConfigurationError('REMOTE_MEDIA_LOAD_HOST_NOT_ALLOWED');
        }
    }
    return target.origin;
};

const parseObjectIds = (value, required, missingCode, invalidCode) => {
    const values = parseCsv(value);
    if (required && values.length === 0) throw new LoadConfigurationError(missingCode);
    if (values.length > 128 || values.some((id) => !/^[0-9a-f]{24}$/i.test(id))) {
        throw new LoadConfigurationError(invalidCode);
    }
    return values;
};

export const loadConfiguration = (env = process.env) => {
    const origin = validateTargetPolicy(
        env.MEDIA_LOAD_BASE_URL ?? 'http://127.0.0.1:8081',
        env
    );
    const trackIds = parseObjectIds(
        env.MEDIA_LOAD_TRACK_IDS,
        true,
        'MEDIA_LOAD_TRACK_IDS_REQUIRED',
        'MEDIA_LOAD_TRACK_IDS_INVALID'
    );
    const artworkIds = parseObjectIds(
        env.MEDIA_LOAD_ARTWORK_IDS,
        false,
        'MEDIA_LOAD_ARTWORK_IDS_REQUIRED',
        'MEDIA_LOAD_ARTWORK_IDS_INVALID'
    );
    const clients = parseBoundedInteger(
        env.MEDIA_LOAD_CLIENTS,
        4,
        1,
        MAX_CLIENTS,
        'MEDIA_LOAD_CLIENTS_INVALID'
    );
    const seekCycles = parseBoundedInteger(
        env.MEDIA_LOAD_SEEK_CYCLES,
        4,
        1,
        20,
        'MEDIA_LOAD_SEEK_CYCLES_INVALID'
    );
    const artworkConcurrency = parseBoundedInteger(
        env.MEDIA_LOAD_ARTWORK_CONCURRENCY,
        4,
        1,
        MAX_CLIENTS,
        'MEDIA_LOAD_ARTWORK_CONCURRENCY_INVALID'
    );
    const requestTimeoutMs = parseBoundedInteger(
        env.MEDIA_LOAD_REQUEST_TIMEOUT_MS,
        10_000,
        500,
        30_000,
        'MEDIA_LOAD_REQUEST_TIMEOUT_MS_INVALID'
    );
    const seekDelayMs = parseBoundedInteger(
        env.MEDIA_LOAD_SEEK_DELAY_MS,
        75,
        0,
        1_000,
        'MEDIA_LOAD_SEEK_DELAY_MS_INVALID'
    );
    const healthPollLimit = parseBoundedInteger(
        env.MEDIA_LOAD_HEALTH_POLLS,
        40,
        1,
        100,
        'MEDIA_LOAD_HEALTH_POLLS_INVALID'
    );
    const artworkWorkload = buildArtworkWorkload(artworkIds, artworkConcurrency);
    const recoveryPollLimit = Math.ceil(
        HEALTH_RECOVERY_TIMEOUT_MS / HEALTH_RECOVERY_INTERVAL_MS
    ) + 1;
    const plannedMediaRequests = trackIds.length
        + clients * (3 + seekCycles)
        + artworkWorkload.length;
    const plannedRequestCeiling = plannedMediaRequests
        + 1
        + healthPollLimit
        + recoveryPollLimit;
    if (plannedRequestCeiling > MAX_TOTAL_REQUESTS) {
        throw new LoadConfigurationError('MEDIA_LOAD_TOTAL_REQUEST_LIMIT_EXCEEDED');
    }

    return Object.freeze({
        origin,
        trackIds: Object.freeze(trackIds),
        artworkIds: Object.freeze(artworkIds),
        artworkWorkload: Object.freeze(artworkWorkload),
        clients,
        seekCycles,
        artworkConcurrency,
        requestTimeoutMs,
        seekDelayMs,
        healthPollLimit,
        recoveryPollLimit,
        plannedRequestCeiling
    });
};

export const parseContentRange = (value) => {
    const normalized = String(value ?? '').trim();
    const partial = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(normalized);
    if (partial) {
        const start = Number(partial[1]);
        const end = Number(partial[2]);
        const size = Number(partial[3]);
        if ([start, end, size].every(Number.isSafeInteger)) {
            return { type: 'partial', start, end, size };
        }
    }
    const unsatisfied = /^bytes \*\/(\d+)$/.exec(normalized);
    if (unsatisfied) {
        const size = Number(unsatisfied[1]);
        if (Number.isSafeInteger(size)) return { type: 'unsatisfied', size };
    }
    return null;
};

const safeContentLength = (headers) => {
    const value = Number(headers.get('content-length'));
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
};

export const validateHeadContract = (status, headers) => {
    if (status !== 200) return { errors: ['HEAD_STATUS'], metadata: null };
    const size = safeContentLength(headers);
    const etag = String(headers.get('etag') ?? '').trim();
    const errors = [];
    if (!size) errors.push('HEAD_CONTENT_LENGTH');
    if (!etag) errors.push('HEAD_ETAG');
    if (String(headers.get('accept-ranges') ?? '').toLowerCase() !== 'bytes') {
        errors.push('HEAD_ACCEPT_RANGES');
    }
    return {
        errors,
        metadata: errors.length === 0 ? { size, etag } : null
    };
};

export const validatePartialContract = ({
    status,
    headers,
    fileSize,
    start,
    end,
    etag,
    operation
}) => {
    if (status !== 206) return [`${operation}_STATUS`];
    const errors = [];
    const contentRange = parseContentRange(headers.get('content-range'));
    if (!contentRange
        || contentRange.type !== 'partial'
        || contentRange.start !== start
        || contentRange.end !== end
        || contentRange.size !== fileSize) {
        errors.push(`${operation}_CONTENT_RANGE`);
    }
    if (safeContentLength(headers) !== end - start + 1) {
        errors.push(`${operation}_CONTENT_LENGTH`);
    }
    if (String(headers.get('accept-ranges') ?? '').toLowerCase() !== 'bytes') {
        errors.push(`${operation}_ACCEPT_RANGES`);
    }
    if (!headers.get('etag') || headers.get('etag') !== etag) {
        errors.push(`${operation}_ETAG`);
    }
    return errors;
};

export const validateInvalidRangeContract = (status, headers, fileSize) => {
    if (status !== 416) return ['RANGE_INVALID_STATUS'];
    const contentRange = parseContentRange(headers.get('content-range'));
    return contentRange?.type === 'unsatisfied' && contentRange.size === fileSize
        ? []
        : ['RANGE_INVALID_CONTENT_RANGE'];
};

/** Verifies that display artwork is versioned WebP with mandatory revalidation. */
export const validateArtworkContract = (status, headers) => {
    if (status === 429) {
        return [
            'ARTWORK_THROTTLED',
            ...(headers.get('retry-after') ? [] : ['ARTWORK_RETRY_AFTER'])
        ];
    }
    if (status !== 200) return ['ARTWORK_STATUS'];

    const errors = [];
    if (!String(headers.get('etag') ?? '').trim()) errors.push('ARTWORK_ETAG');
    if (!safeContentLength(headers)) errors.push('ARTWORK_CONTENT_LENGTH');
    if (String(headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
        !== 'image/webp') {
        errors.push('ARTWORK_CONTENT_TYPE');
    }
    const cacheControl = String(headers.get('cache-control') ?? '').toLowerCase();
    if (!cacheControl.includes('public')) errors.push('ARTWORK_CACHE_PUBLIC');
    if (!cacheControl.includes('no-cache')) errors.push('ARTWORK_CACHE_REVALIDATION');
    return errors;
};

export const buildSeekStarts = (fileSize, count) => {
    const fractions = [0.1, 0.35, 0.2, 0.7, 0.5, 0.9, 0.65, 0.25];
    return Array.from({ length: count }, (_, index) => Math.min(
        fileSize - 1,
        Math.max(0, Math.floor(fileSize * fractions[index % fractions.length]))
    ));
};

const operationNames = [
    'head',
    'rangeStart',
    'rangeOpen',
    'rangeSuffix',
    'rangeInvalid',
    'artwork',
    'health'
];

export const createAggregateStats = (plannedRequestCeiling) => ({
    requests: {
        limit: MAX_TOTAL_REQUESTS,
        plannedCeiling: plannedRequestCeiling,
        attempted: 0,
        completed: 0,
        aborted: 0,
        networkErrors: 0,
        bytesRead: 0
    },
    responses: {
        status2xx: 0,
        status4xx: 0,
        status429: 0,
        status5xx: 0,
        other: 0
    },
    operations: Object.fromEntries(operationNames.map((name) => [name, {
        attempted: 0,
        completed: 0,
        aborted: 0
    }])),
    playback: {
        attempted: 0,
        aborted: 0,
        status429: 0,
        status5xx: 0,
        validationFailures: 0
    },
    artwork: {
        attempted: 0,
        status429: 0,
        status5xx: 0,
        validationFailures: 0
    },
    health: {
        samples: 0,
        non200: 0,
        maxActiveRequests: 0,
        baselineActiveRequests: null,
        finalActiveRequests: null,
        playbackRejectedDelta: null,
        playbackServerErrorDelta: null,
        recoveredWithinTwoSeconds: false
    },
    validationFailures: {}
});

export const createRequestBudget = (limit = MAX_TOTAL_REQUESTS) => {
    let used = 0;
    return {
        consume() {
            if (used >= limit) throw new LoadConfigurationError('MEDIA_LOAD_REQUEST_BUDGET_EXHAUSTED');
            used += 1;
            return used;
        },
        used: () => used,
        remaining: () => limit - used
    };
};

const groupForOperation = (operation) => operation === 'artwork'
    ? 'artwork'
    : operation === 'health' ? 'health' : 'playback';

const recordValidation = (stats, group, code) => {
    stats.validationFailures[code] = (stats.validationFailures[code] ?? 0) + 1;
    if (group === 'playback' || group === 'artwork') {
        stats[group].validationFailures += 1;
    }
};

const recordStatus = (stats, group, status) => {
    if (status === 429) stats.responses.status429 += 1;
    else if (status >= 200 && status < 300) stats.responses.status2xx += 1;
    else if (status >= 400 && status < 500) stats.responses.status4xx += 1;
    else if (status >= 500 && status < 600) stats.responses.status5xx += 1;
    else stats.responses.other += 1;
    if (group === 'playback' || group === 'artwork') {
        if (status === 429) stats[group].status429 += 1;
        if (status >= 500 && status < 600) stats[group].status5xx += 1;
    }
    if (group === 'health' && status !== 200) stats.health.non200 += 1;
};

const startRequest = async (runtime, operation, pathname, init = {}) => {
    const { config, budget, stats, fetchImpl } = runtime;
    budget.consume();
    stats.requests.attempted += 1;
    stats.operations[operation].attempted += 1;
    const group = groupForOperation(operation);
    if (group === 'playback' || group === 'artwork') stats[group].attempted += 1;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
    try {
        const response = await fetchImpl(new URL(pathname, config.origin), {
            ...init,
            cache: 'no-store',
            credentials: 'omit',
            redirect: 'error',
            signal: controller.signal
        });
        recordStatus(stats, group, response.status);
        return {
            response,
            controller,
            clearTimeout: () => clearTimeout(timeout),
            operation,
            group
        };
    } catch {
        clearTimeout(timeout);
        stats.requests.networkErrors += 1;
        recordValidation(stats, group, `${operation.toUpperCase()}_REQUEST_FAILED`);
        return null;
    }
};

const drainBody = async (response) => {
    if (!response.body) return 0;
    const reader = response.body.getReader();
    let bytesRead = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) return bytesRead;
        bytesRead += value?.byteLength ?? 0;
    }
};

const completeResponse = async (runtime, request) => {
    if (!request) return false;
    try {
        const bytesRead = await drainBody(request.response);
        runtime.stats.requests.bytesRead += bytesRead;
        runtime.stats.requests.completed += 1;
        runtime.stats.operations[request.operation].completed += 1;
        return true;
    } catch {
        runtime.stats.requests.networkErrors += 1;
        recordValidation(runtime.stats, request.group, `${request.operation.toUpperCase()}_BODY_FAILED`);
        return false;
    } finally {
        request.clearTimeout();
    }
};

const applyValidation = (stats, group, errors) => {
    for (const error of errors) recordValidation(stats, group, error);
    return errors.length === 0;
};

const headTrack = async (runtime, trackId) => {
    const request = await startRequest(
        runtime,
        'head',
        `/content/audioTrack/stream/${encodeURIComponent(trackId)}`,
        { method: 'HEAD' }
    );
    if (!request) return null;
    const result = validateHeadContract(request.response.status, request.response.headers);
    applyValidation(runtime.stats, 'playback', result.errors);
    await completeResponse(runtime, request);
    return result.metadata;
};

const boundedRange = async (runtime, trackId, metadata, operation, start, end, rangeValue) => {
    const request = await startRequest(
        runtime,
        operation,
        `/content/audioTrack/stream/${encodeURIComponent(trackId)}`,
        { headers: { Range: rangeValue } }
    );
    if (!request) return;
    applyValidation(runtime.stats, 'playback', validatePartialContract({
        status: request.response.status,
        headers: request.response.headers,
        fileSize: metadata.size,
        start,
        end,
        etag: metadata.etag,
        operation: operation === 'rangeStart' ? 'RANGE_START' : 'RANGE_SUFFIX'
    }));
    await completeResponse(runtime, request);
};

const invalidRange = async (runtime, trackId, metadata) => {
    const request = await startRequest(
        runtime,
        'rangeInvalid',
        `/content/audioTrack/stream/${encodeURIComponent(trackId)}`,
        { headers: { Range: `bytes=${metadata.size}-` } }
    );
    if (!request) return;
    applyValidation(
        runtime.stats,
        'playback',
        validateInvalidRangeContract(
            request.response.status,
            request.response.headers,
            metadata.size
        )
    );
    await completeResponse(runtime, request);
};

const beginOpenRange = async (runtime, trackId, metadata, start) => {
    const request = await startRequest(
        runtime,
        'rangeOpen',
        `/content/audioTrack/stream/${encodeURIComponent(trackId)}`,
        { headers: { Range: `bytes=${start}-` } }
    );
    if (!request) return null;
    const valid = applyValidation(runtime.stats, 'playback', validatePartialContract({
        status: request.response.status,
        headers: request.response.headers,
        fileSize: metadata.size,
        start,
        end: metadata.size - 1,
        etag: metadata.etag,
        operation: 'RANGE_OPEN'
    }));
    if (!request.response.body) {
        request.clearTimeout();
        runtime.stats.requests.completed += 1;
        runtime.stats.operations.rangeOpen.completed += 1;
        return null;
    }
    const reader = request.response.body.getReader();
    try {
        const first = await reader.read();
        runtime.stats.requests.bytesRead += first.value?.byteLength ?? 0;
        if (first.done) {
            request.clearTimeout();
            runtime.stats.requests.completed += 1;
            runtime.stats.operations.rangeOpen.completed += 1;
            return null;
        }
    } catch {
        request.clearTimeout();
        runtime.stats.requests.networkErrors += 1;
        recordValidation(runtime.stats, 'playback', 'RANGE_OPEN_BODY_FAILED');
        return null;
    }
    if (!valid) {
        request.controller.abort();
        await reader.cancel().catch(() => undefined);
        request.clearTimeout();
        runtime.stats.requests.aborted += 1;
        runtime.stats.operations.rangeOpen.aborted += 1;
        runtime.stats.playback.aborted += 1;
        return null;
    }
    return { ...request, reader };
};

const abortOpenRange = async (runtime, request) => {
    if (!request) return;
    request.controller.abort();
    await request.reader.cancel().catch(() => undefined);
    request.clearTimeout();
    runtime.stats.requests.aborted += 1;
    runtime.stats.operations.rangeOpen.aborted += 1;
    runtime.stats.playback.aborted += 1;
};

const runListener = async (runtime, trackId, metadata) => {
    const firstEnd = Math.min(metadata.size - 1, RANGE_SAMPLE_BYTES - 1);
    await boundedRange(
        runtime,
        trackId,
        metadata,
        'rangeStart',
        0,
        firstEnd,
        `bytes=0-${firstEnd}`
    );

    let previous = null;
    try {
        for (const start of buildSeekStarts(metadata.size, runtime.config.seekCycles)) {
            const current = await beginOpenRange(runtime, trackId, metadata, start);
            await abortOpenRange(runtime, previous);
            previous = current;
            if (runtime.config.seekDelayMs > 0) {
                await new Promise((resolveDelay) => setTimeout(resolveDelay, runtime.config.seekDelayMs));
            }
        }
    } finally {
        await abortOpenRange(runtime, previous);
    }

    const suffixLength = Math.min(metadata.size, RANGE_SAMPLE_BYTES);
    await boundedRange(
        runtime,
        trackId,
        metadata,
        'rangeSuffix',
        metadata.size - suffixLength,
        metadata.size - 1,
        `bytes=-${suffixLength}`
    );
    await invalidRange(runtime, trackId, metadata);
};

const loadArtwork = async (runtime, artworkId, requestIndex) => {
    const request = await startRequest(
        runtime,
        'artwork',
        buildArtworkVariantPath(artworkId, requestIndex)
    );
    if (!request) return;
    applyValidation(
        runtime.stats,
        'artwork',
        validateArtworkContract(request.response.status, request.response.headers)
    );
    await completeResponse(runtime, request);
};

export const runBounded = async (items, concurrency, operation) => {
    let nextIndex = 0;
    const worker = async () => {
        while (true) {
            const index = nextIndex;
            nextIndex += 1;
            if (index >= items.length) return;
            await operation(items[index], index);
        }
    };
    await Promise.all(Array.from(
        { length: Math.min(Math.max(1, concurrency), Math.max(1, items.length)) },
        worker
    ));
};

const metricNumber = (value) => Number.isFinite(Number(value)) && Number(value) >= 0
    ? Number(value)
    : null;

const parseHealthSnapshot = (body) => {
    const media = body?.mediaDelivery;
    const playback = media?.byResource?.playback;
    const activeRequests = metricNumber(media?.activeRequests);
    const playbackActive = metricNumber(playback?.activeRequests);
    const playbackRejected = metricNumber(playback?.rejectedRequests);
    const playbackServerErrors = metricNumber(playback?.responseOutcomes?.serverError);
    if ([activeRequests, playbackActive, playbackRejected, playbackServerErrors]
        .some((value) => value === null)) return null;
    return {
        activeRequests,
        playbackActive,
        playbackRejected,
        playbackServerErrors
    };
};

const readHealth = async (runtime) => {
    const request = await startRequest(runtime, 'health', '/health');
    if (!request) return null;
    runtime.stats.health.samples += 1;
    if (request.response.status !== 200) {
        recordValidation(runtime.stats, 'health', 'HEALTH_STATUS');
        await completeResponse(runtime, request);
        return null;
    }
    try {
        const body = await request.response.json();
        const snapshot = parseHealthSnapshot(body);
        if (!snapshot) {
            recordValidation(runtime.stats, 'health', 'HEALTH_METRICS');
            return null;
        }
        runtime.stats.health.maxActiveRequests = Math.max(
            runtime.stats.health.maxActiveRequests,
            snapshot.activeRequests
        );
        return snapshot;
    } catch {
        recordValidation(runtime.stats, 'health', 'HEALTH_BODY');
        return null;
    } finally {
        request.clearTimeout();
        runtime.stats.requests.completed += 1;
        runtime.stats.operations.health.completed += 1;
    }
};

const startHealthPolling = (runtime) => {
    let stopped = false;
    const promise = (async () => {
        for (let index = 0; index < runtime.config.healthPollLimit && !stopped; index += 1) {
            await readHealth(runtime);
            if (!stopped) await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
        }
    })();
    return {
        stop: async () => {
            stopped = true;
            await promise;
        }
    };
};

const waitForHealthRecovery = async (runtime, baseline) => {
    const deadline = Date.now() + HEALTH_RECOVERY_TIMEOUT_MS;
    let lastSnapshot = null;
    for (let attempt = 0; attempt < runtime.config.recoveryPollLimit; attempt += 1) {
        lastSnapshot = await readHealth(runtime);
        if (lastSnapshot
            && lastSnapshot.activeRequests <= baseline.activeRequests
            && lastSnapshot.playbackActive <= baseline.playbackActive) {
            return { recovered: true, snapshot: lastSnapshot };
        }
        if (Date.now() >= deadline) break;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, HEALTH_RECOVERY_INTERVAL_MS));
    }
    return { recovered: false, snapshot: lastSnapshot };
};

/** Runs the bounded workload and returns only aggregate, non-identifying output. */
export const runMediaRangeLoad = async (env = process.env, fetchImpl = globalThis.fetch) => {
    if (typeof fetchImpl !== 'function') throw new LoadConfigurationError('FETCH_UNAVAILABLE');
    const config = loadConfiguration(env);
    const stats = createAggregateStats(config.plannedRequestCeiling);
    const runtime = {
        config,
        stats,
        budget: createRequestBudget(MAX_TOTAL_REQUESTS),
        fetchImpl
    };
    const startedAt = Date.now();
    const baseline = await readHealth(runtime);
    if (!baseline) {
        return {
            ok: false,
            durationMs: Date.now() - startedAt,
            configuration: {
                clients: config.clients,
                tracks: config.trackIds.length,
                artwork: config.artworkIds.length,
                artworkRequests: config.artworkWorkload.length,
                seekCycles: config.seekCycles
            },
            ...stats
        };
    }
    stats.health.baselineActiveRequests = baseline.activeRequests;

    const metadataByTrack = new Map();
    await runBounded(config.trackIds, Math.min(4, config.clients), async (trackId) => {
        const metadata = await headTrack(runtime, trackId);
        if (metadata) metadataByTrack.set(trackId, metadata);
    });

    const runnableTracks = config.trackIds.filter((trackId) => metadataByTrack.has(trackId));
    const monitor = startHealthPolling(runtime);
    await Promise.all([
        runnableTracks.length === 0
            ? Promise.resolve()
            : Promise.all(Array.from({ length: config.clients }, (_, index) => {
                const trackId = runnableTracks[index % runnableTracks.length];
                return runListener(runtime, trackId, metadataByTrack.get(trackId));
            })),
        runBounded(
            config.artworkWorkload,
            config.artworkConcurrency,
            (artworkId, requestIndex) => loadArtwork(runtime, artworkId, requestIndex)
        )
    ]);
    await monitor.stop();

    const recovery = await waitForHealthRecovery(runtime, baseline);
    const finalSnapshot = recovery.snapshot;
    stats.health.recoveredWithinTwoSeconds = recovery.recovered;
    stats.health.finalActiveRequests = finalSnapshot?.activeRequests ?? null;
    stats.health.playbackRejectedDelta = finalSnapshot
        ? Math.max(0, finalSnapshot.playbackRejected - baseline.playbackRejected)
        : null;
    stats.health.playbackServerErrorDelta = finalSnapshot
        ? Math.max(0, finalSnapshot.playbackServerErrors - baseline.playbackServerErrors)
        : null;
    if (!recovery.recovered) recordValidation(stats, 'health', 'HEALTH_ACTIVE_NOT_RECOVERED');
    if (runnableTracks.length !== config.trackIds.length) {
        recordValidation(stats, 'playback', 'TRACK_PREFLIGHT_FAILED');
    }

    const ok = Object.keys(stats.validationFailures).length === 0
        && stats.requests.networkErrors === 0
        && stats.playback.status429 === 0
        && stats.playback.status5xx === 0
        && stats.artwork.status429 === 0
        && stats.artwork.status5xx === 0
        && stats.health.non200 === 0
        && stats.health.playbackRejectedDelta === 0
        && stats.health.playbackServerErrorDelta === 0
        && stats.health.recoveredWithinTwoSeconds;

    return {
        ok,
        durationMs: Date.now() - startedAt,
        configuration: {
            clients: config.clients,
            tracks: config.trackIds.length,
            artwork: config.artworkIds.length,
            artworkRequests: config.artworkWorkload.length,
            seekCycles: config.seekCycles
        },
        ...stats
    };
};

export const runCli = async (argv = process.argv.slice(2), env = process.env) => {
    if (argv.includes('--help') || argv.includes('-h')) {
        process.stdout.write(`${HELP}\n`);
        return 0;
    }
    try {
        const summary = await runMediaRangeLoad(env);
        process.stdout.write(`${JSON.stringify(summary)}\n`);
        return summary.ok ? 0 : 1;
    } catch (error) {
        const code = error instanceof LoadConfigurationError
            ? error.code
            : 'UNEXPECTED_FAILURE';
        process.stdout.write(`${JSON.stringify({ ok: false, error: code })}\n`);
        return 1;
    }
};

const isMain = process.argv[1]
    && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
    runCli().then((exitCode) => {
        process.exitCode = exitCode;
    });
}
