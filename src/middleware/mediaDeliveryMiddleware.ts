import { NextFunction, Request, RequestHandler, Response } from 'express';
import { onRequestWorkComplete } from '../services/serverLifecycleService';
import {
    createMediaDeliveryMetricsRegistry,
    defaultMediaDeliveryMetrics,
    MediaAdmissionLimitsSnapshot,
    MediaDeliveryMetricsRegistry,
    MediaResourceClass,
    MediaResponseOutcome
} from '../services/mediaDeliveryService';

export interface MediaAdmissionControllerOptions {
    globalLimit?: number;
    perIpLimit?: number;
    playbackReservedGlobal?: number;
    playbackReservedPerIp?: number;
    metrics?: MediaDeliveryMetricsRegistry;
    /** Only playback GETs may briefly wait for an existing slot; active ceilings never change. */
    playbackWaitMs?: number;
    playbackQueueGlobal?: number;
    playbackQueuePerIp?: number;
}

export interface MediaAdmissionController {
    limits: MediaAdmissionLimitsSnapshot;
    middleware(resourceClass: MediaResourceClass): RequestHandler;
    getMetrics(): ReturnType<MediaDeliveryMetricsRegistry['snapshot']>;
    getQueuedPlaybackRequests(): number;
}

type ClientActivity = {
    total: number;
    nonPlayback: number;
};

const positiveInteger = (value: number | string | undefined, fallback: number) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

const boundedReserve = (
    value: number | string | undefined,
    fallback: number,
    totalLimit: number
) => {
    const parsed = Number(value);
    const selected = Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
    // Keep at least one non-playback slot whenever the total pool has capacity for it.
    return Math.min(Math.max(0, selected), Math.max(0, totalLimit - 1));
};

const responseOutcome = (
    res: Response,
    closedBeforeFinish: boolean
): MediaResponseOutcome => {
    if (closedBeforeFinish) return 'aborted';
    if (res.statusCode >= 200 && res.statusCode < 400) return 'success';
    if (res.statusCode >= 400 && res.statusCode < 500) return 'clientError';
    if (res.statusCode >= 500 && res.statusCode < 600) return 'serverError';
    return 'other';
};

/**
 * Creates one testable admission pool that preserves playback slots while
 * retaining the deployment-wide total and per-client safety ceilings.
 */
export const createMediaAdmissionController = (
    options: MediaAdmissionControllerOptions = {}
): MediaAdmissionController => {
    const globalLimit = positiveInteger(options.globalLimit, 40);
    const perIpLimit = positiveInteger(options.perIpLimit, 8);
    const defaultGlobalReserve = Math.floor(globalLimit * 0.4);
    const defaultPerIpReserve = Math.floor(perIpLimit * 0.25);
    const limits: MediaAdmissionLimitsSnapshot = {
        global: globalLimit,
        perIp: perIpLimit,
        playbackReservedGlobal: boundedReserve(
            options.playbackReservedGlobal,
            defaultGlobalReserve,
            globalLimit
        ),
        playbackReservedPerIp: boundedReserve(
            options.playbackReservedPerIp,
            defaultPerIpReserve,
            perIpLimit
        )
    };
    const metrics = options.metrics ?? createMediaDeliveryMetricsRegistry();
    metrics.setAdmissionLimits(limits);

    const activeByClient = new Map<string, ClientActivity>();
    let globalActive = 0;
    let globalNonPlayback = 0;
    const waitMs = Math.min(2_000, positiveInteger(options.playbackWaitMs, 0));
    const queueGlobal = Math.min(32, positiveInteger(options.playbackQueueGlobal, 32));
    const queuePerIp = Math.min(8, positiveInteger(options.playbackQueuePerIp, 8));
    type WaitingPlayback = {
        clientId: string;
        res: Response;
        detach: () => void;
        admit: () => void;
        blocked: () => boolean;
    };
    const waiting: WaitingPlayback[] = [];
    let drainingQueue = false;

    /** A saturated client cannot prevent another client's available slot from being used. */
    const drainQueue = () => {
        if (drainingQueue) return;
        drainingQueue = true;
        try {
            for (let index = 0; index < waiting.length;) {
                const entry = waiting[index];
                if (entry.blocked()) {
                    index++;
                    continue;
                }
                waiting.splice(index, 1);
                entry.detach();
                if (!entry.res.destroyed && !entry.res.writableEnded) entry.admit();
            }
        } finally {
            drainingQueue = false;
        }
    };

    const middleware = (resourceClass: MediaResourceClass): RequestHandler => {
        return (req: Request, res: Response, next: NextFunction) => {
            if (req.aborted || res.destroyed || res.writableEnded) return;
            const clientId = req.ip || req.socket.remoteAddress || 'unknown';
            const isPlayback = resourceClass === 'playback' || resourceClass === 'video';
            const nonPlaybackGlobalLimit = limits.global - limits.playbackReservedGlobal;
            const nonPlaybackClientLimit = limits.perIp - limits.playbackReservedPerIp;

            const rejectionReason = () => globalActive >= limits.global
                ? 'global' as const
                : (activeByClient.get(clientId)?.total ?? 0) >= limits.perIp
                    ? 'perIp' as const
                    : !isPlayback && (
                        globalNonPlayback >= nonPlaybackGlobalLimit
                        || (activeByClient.get(clientId)?.nonPlayback ?? 0) >= nonPlaybackClientLimit
                    )
                        ? 'playbackReserved' as const
                        : null;

            const reject = () => {
                metrics.markRequestRejected(resourceClass, rejectionReason() ?? 'perIp');
                res.setHeader('Retry-After', '2');
                return res.status(429).json({ message: 'Too many concurrent media requests.' });
            };

            const admit = () => {
                const clientActivity = activeByClient.get(clientId) ?? { total: 0, nonPlayback: 0 };
                clientActivity.total += 1;
                globalActive += 1;
                if (!isPlayback) {
                    clientActivity.nonPlayback += 1;
                    globalNonPlayback += 1;
                }
                activeByClient.set(clientId, clientActivity);
                metrics.markRequestAccepted(resourceClass);
                res.locals.mediaDelivery = { resourceClass, metrics };

                let released = false;
                const release = () => {
                    if (released) return;
                    released = true;
                    clientActivity.total = Math.max(0, clientActivity.total - 1);
                    globalActive = Math.max(0, globalActive - 1);
                    if (!isPlayback) {
                        clientActivity.nonPlayback = Math.max(0, clientActivity.nonPlayback - 1);
                        globalNonPlayback = Math.max(0, globalNonPlayback - 1);
                    }
                    if (clientActivity.total === 0) activeByClient.delete(clientId);
                    else activeByClient.set(clientId, clientActivity);
                    metrics.markRequestFinished(resourceClass, responseOutcome(res, !res.writableEnded));
                    drainQueue();
                };
                // Disconnect does not release capacity while an admitted storage/handler promise is still settling.
                onRequestWorkComplete(req, res, release);
                return next();
            };
            if (!rejectionReason()) return admit();
            if (!waitMs || !isPlayback || req.method !== 'GET' || waiting.length >= queueGlobal
                || waiting.filter(value => value.clientId === clientId).length >= queuePerIp) return reject();

            // Queue only the original bounded read, before source validation/storage work; no command is replayed.
            let timer: ReturnType<typeof setTimeout>;
            const entry: WaitingPlayback = {
                clientId, res, admit, blocked: () => Boolean(rejectionReason()),
                detach: () => {
                    clearTimeout(timer);
                    res.off('close', cancel);
                    res.off('finish', cancel);
                }
            };
            const remove = () => {
                const index = waiting.indexOf(entry);
                if (index < 0) return false;
                waiting.splice(index, 1);
                entry.detach();
                return true;
            };
            const cancel = () => { if (remove()) drainQueue(); };
            timer = setTimeout(() => {
                if (remove() && !res.destroyed && !res.writableEnded) reject();
            }, waitMs);
            res.once('close', cancel);
            res.once('finish', cancel);
            waiting.push(entry);
        };
    };

    return {
        limits,
        middleware,
        getMetrics: () => metrics.snapshot(),
        getQueuedPlaybackRequests: () => waiting.length
    };
};

const configuredGlobalLimit = positiveInteger(process.env.MAX_MEDIA_REQUESTS_GLOBAL, 40);
const configuredPerIpLimit = positiveInteger(process.env.MAX_MEDIA_REQUESTS_PER_IP, 8);

export const defaultMediaAdmissionController = createMediaAdmissionController({
    globalLimit: configuredGlobalLimit,
    perIpLimit: configuredPerIpLimit,
    playbackReservedGlobal: process.env.MEDIA_PLAYBACK_RESERVED_GLOBAL === undefined
        ? undefined
        : Number(process.env.MEDIA_PLAYBACK_RESERVED_GLOBAL),
    playbackReservedPerIp: process.env.MEDIA_PLAYBACK_RESERVED_PER_IP === undefined
        ? undefined
        : Number(process.env.MEDIA_PLAYBACK_RESERVED_PER_IP),
    metrics: defaultMediaDeliveryMetrics,
    playbackWaitMs: 2_000,
    playbackQueueGlobal: 32,
    playbackQueuePerIp: 8
});

/** Classifies each route without exposing that class as request-controlled input. */
export const limitMediaConcurrencyFor = (resourceClass: MediaResourceClass) => (
    defaultMediaAdmissionController.middleware(resourceClass)
);

/** Records independently bounded work without placing it in the playback admission pool. */
export const observeMediaDeliveryFor = (
    resourceClass: MediaResourceClass,
    metrics: MediaDeliveryMetricsRegistry = defaultMediaDeliveryMetrics
): RequestHandler => (req, res, next) => {
    metrics.markRequestAccepted(resourceClass);
    res.locals.mediaDelivery = { resourceClass, metrics };

    let released = false;
    const release = (closedBeforeFinish: boolean) => {
        if (released) return;
        released = true;
        res.off('finish', onFinish);
        res.off('close', onClose);
        metrics.markRequestFinished(resourceClass, responseOutcome(res, closedBeforeFinish));
    };
    const onFinish = () => release(false);
    const onClose = () => release(!res.writableEnded);
    res.once('finish', onFinish);
    res.once('close', onClose);
    return next();
};

// Compatibility default for any older playback route that imports this handler directly.
export const limitMediaConcurrency = limitMediaConcurrencyFor('playback');
