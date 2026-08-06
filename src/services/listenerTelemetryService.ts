export const listenerTelemetryRoutes = [
    'home',
    'search',
    'library',
    'playlists',
    'playlist',
    'album',
    'artist',
    'account',
    'auth',
    'not_found',
    'other'
] as const;

export type ListenerTelemetryRoute = typeof listenerTelemetryRoutes[number];

const webVitalMetrics = ['LCP', 'CLS', 'INP'] as const;
const navigationTypes = ['navigate', 'reload', 'back_forward', 'prerender', 'unknown'] as const;
const routeErrorKinds = ['render', 'route_response', 'lazy_chunk', 'unknown'] as const;
const statusBuckets = ['none', '400', '401', '403', '404', '409', '422', '428', '429', '5xx', 'other'] as const;
const apiOperations = [
    'listener_capabilities',
    'listener_home',
    'listener_search',
    'listener_library',
    'listener_album',
    'listener_artist',
    'listener_track',
    'save_status',
    'save',
    'unsave',
    'recent_activity',
    'playlist_list',
    'playlist_memberships',
    'playlist_detail',
    'playlist_create',
    'playlist_rename',
    'playlist_delete',
    'playlist_add',
    'playlist_remove',
    'playlist_reorder'
] as const;
const apiErrorKinds = ['http', 'network', 'invalid_response'] as const;
const apiAttempts = ['initial', 'after_refresh'] as const;
const latencyBuckets = ['under_250ms', '250_to_999ms', '1_to_3s', 'over_3s'] as const;
const playbackStages = ['audio_create', 'source_set', 'play_call', 'media_element'] as const;
const playbackCodes = ['autoplayBlocked', 'network', 'decode', 'streamUnavailable', 'unknown'] as const;

export type ListenerTelemetryEvent =
    | {
        category: 'web_vital';
        route: ListenerTelemetryRoute;
        metric: typeof webVitalMetrics[number];
        value: number;
        navigationType?: typeof navigationTypes[number];
    }
    | {
        category: 'route_error';
        route: ListenerTelemetryRoute;
        kind: typeof routeErrorKinds[number];
        statusBucket: typeof statusBuckets[number];
    }
    | {
        category: 'api_error';
        route: ListenerTelemetryRoute;
        operation: typeof apiOperations[number];
        kind: typeof apiErrorKinds[number];
        statusBucket: typeof statusBuckets[number];
        attempt: typeof apiAttempts[number];
        latencyBucket?: typeof latencyBuckets[number];
    }
    | {
        category: 'playback_error';
        route: ListenerTelemetryRoute;
        stage: typeof playbackStages[number];
        code: typeof playbackCodes[number];
    };

export type RecordedListenerTelemetryEvent = ListenerTelemetryEvent & {
    schemaVersion: 1;
    occurredAt: string;
};

export type ListenerTelemetrySink = (event: RecordedListenerTelemetryEvent) => void;

/** Marks a telemetry payload as invalid without reflecting its untrusted fields. */
export class ListenerTelemetryValidationError extends Error {
    readonly statusCode = 422;

    constructor() {
        super('Invalid listener telemetry payload.');
        this.name = 'ListenerTelemetryValidationError';
    }
}

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
};

const hasExactKeys = (
    value: UnknownRecord,
    required: readonly string[],
    optional: readonly string[] = []
) => {
    const allowed = new Set([...required, ...optional]);
    const keys = Object.keys(value);
    return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
        && keys.every((key) => allowed.has(key));
};

const memberOf = <Value extends string>(
    value: unknown,
    allowed: readonly Value[]
): value is Value => typeof value === 'string' && allowed.includes(value as Value);

const routeFrom = (value: unknown) => {
    if (!memberOf(value, listenerTelemetryRoutes)) throw new ListenerTelemetryValidationError();
    return value;
};

const normalizedVitalValue = (metric: typeof webVitalMetrics[number], value: unknown) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new ListenerTelemetryValidationError();
    }
    if (metric === 'CLS') {
        if (value > 5) throw new ListenerTelemetryValidationError();
        return Math.round(value * 1_000) / 1_000;
    }
    if (value > 60_000) throw new ListenerTelemetryValidationError();
    return Math.round(value);
};

/** Reconstructs one event from explicit allowlists so untrusted fields cannot reach the sink. */
const eventFrom = (value: unknown): ListenerTelemetryEvent => {
    if (!isRecord(value) || typeof value.category !== 'string') {
        throw new ListenerTelemetryValidationError();
    }

    switch (value.category) {
        case 'web_vital': {
            if (!hasExactKeys(value, ['category', 'route', 'metric', 'value'], ['navigationType'])
                || !memberOf(value.metric, webVitalMetrics)
                || (value.navigationType !== undefined && !memberOf(value.navigationType, navigationTypes))) {
                throw new ListenerTelemetryValidationError();
            }
            const event: ListenerTelemetryEvent = {
                category: 'web_vital',
                route: routeFrom(value.route),
                metric: value.metric,
                value: normalizedVitalValue(value.metric, value.value)
            };
            if (value.navigationType !== undefined) event.navigationType = value.navigationType;
            return event;
        }
        case 'route_error':
            if (!hasExactKeys(value, ['category', 'route', 'kind', 'statusBucket'])
                || !memberOf(value.kind, routeErrorKinds)
                || !memberOf(value.statusBucket, statusBuckets)) {
                throw new ListenerTelemetryValidationError();
            }
            return {
                category: 'route_error',
                route: routeFrom(value.route),
                kind: value.kind,
                statusBucket: value.statusBucket
            };
        case 'api_error': {
            if (!hasExactKeys(
                value,
                ['category', 'route', 'operation', 'kind', 'statusBucket', 'attempt'],
                ['latencyBucket']
            )
                || !memberOf(value.operation, apiOperations)
                || !memberOf(value.kind, apiErrorKinds)
                || !memberOf(value.statusBucket, statusBuckets)
                || !memberOf(value.attempt, apiAttempts)
                || (value.latencyBucket !== undefined && !memberOf(value.latencyBucket, latencyBuckets))
                || (value.kind === 'http') === (value.statusBucket === 'none')) {
                throw new ListenerTelemetryValidationError();
            }
            const event: ListenerTelemetryEvent = {
                category: 'api_error',
                route: routeFrom(value.route),
                operation: value.operation,
                kind: value.kind,
                statusBucket: value.statusBucket,
                attempt: value.attempt
            };
            if (value.latencyBucket !== undefined) event.latencyBucket = value.latencyBucket;
            return event;
        }
        case 'playback_error':
            if (!hasExactKeys(value, ['category', 'route', 'stage', 'code'])
                || !memberOf(value.stage, playbackStages)
                || !memberOf(value.code, playbackCodes)) {
                throw new ListenerTelemetryValidationError();
            }
            return {
                category: 'playback_error',
                route: routeFrom(value.route),
                stage: value.stage,
                code: value.code
            };
        default:
            throw new ListenerTelemetryValidationError();
    }
};

/** Accepts only a bounded batch and returns newly owned strict event objects. */
export const parseListenerTelemetryBatch = (payload: unknown): ListenerTelemetryEvent[] => {
    if (!isRecord(payload)
        || !hasExactKeys(payload, ['events'])
        || !Array.isArray(payload.events)
        || payload.events.length < 1
        || payload.events.length > 10) {
        throw new ListenerTelemetryValidationError();
    }
    return payload.events.map(eventFrom);
};

/** Emits anonymous listener events without accepting arbitrary logging context. */
export const consoleListenerTelemetrySink: ListenerTelemetrySink = (event) => {
    console.info(JSON.stringify(event));
};

/** Validates and records one batch using a server-owned timestamp and injectable sink. */
export const recordListenerTelemetryBatch = (
    payload: unknown,
    sink: ListenerTelemetrySink = consoleListenerTelemetrySink,
    now: () => Date = () => new Date()
) => {
    const events = parseListenerTelemetryBatch(payload);
    const occurredAt = now().toISOString();
    events.forEach((event) => sink(Object.freeze({
        schemaVersion: 1 as const,
        occurredAt,
        ...event
    })));
    return events.length;
};
