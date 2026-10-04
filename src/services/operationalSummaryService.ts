import { socialCapacity, type SocialCapacity } from '../config/socialCapacity';
import { writeOperationalLog, type OperationalLog } from '../infrastructure/operationalLog';
import { takeLimiterRejections } from '../middleware/requestProtectionMiddleware';
import { roomGatewayFailureCategories, roomGatewayMetrics, type RoomGatewayMetrics } from '../realtime/roomGatewayMetrics';
import { socialOperations, type SocialOperations } from '../realtime/socialOperations';
import { getMediaDeliveryMetrics } from './mediaDeliveryService';

/** One line a minute keeps CloudWatch ingestion and metric-filter evaluation negligible on the free tier. */
export const OPERATIONAL_SUMMARY_INTERVAL_MS = 60_000;

export interface OperationalSummaryOptions {
    intervalMs?: number;
    log?: OperationalLog;
    capacity?: SocialCapacity;
    metrics?: Pick<RoomGatewayMetrics, 'snapshot'>;
    operations?: Pick<SocialOperations, 'take'>;
    takeLimiterRejections?: () => Record<string, number>;
    mediaRejectedRequests?: () => number;
}

const sum = (values: Record<string, number>) => Object.values(values).reduce((total, value) => total + value, 0);

/**
 * Writes `ops_summary`: current room gauges, this interval's socket, ticket, fanout, lifecycle, capacity and
 * failure counts, and every 429 per limiter. Fields have a fixed shape and numeric values so CloudWatch JSON
 * metric filters can select them (for example `$.rooms.openSockets`); `total` fields serve alarms whose
 * per-scope keys are not valid filter selectors. Failure counters become per-interval deltas here.
 */
export const createOperationalSummary = (options: OperationalSummaryOptions = {}) => {
    const intervalMs = options.intervalMs ?? OPERATIONAL_SUMMARY_INTERVAL_MS;
    const log = options.log ?? writeOperationalLog;
    const capacity = options.capacity ?? socialCapacity();
    const metrics = options.metrics ?? roomGatewayMetrics;
    const operations = options.operations ?? socialOperations;
    const takeLimiters = options.takeLimiterRejections ?? takeLimiterRejections;
    const mediaRejected = options.mediaRejectedRequests ?? (() => getMediaDeliveryMetrics().rejectedRequests);
    let previous = metrics.snapshot();
    let previousMediaRejected = mediaRejected();

    const flush = () => {
        const rooms = metrics.snapshot();
        const counts = operations.take();
        const failures = Object.fromEntries(roomGatewayFailureCategories.map(category =>
            [category, Math.max(0, rooms.failures[category] - previous.failures[category])]));
        const limiters = takeLimiters();
        const media = mediaRejected();
        // Media admission keeps its own registry; its interval delta joins the limiter view under one scope.
        if (media > previousMediaRejected) limiters['media-delivery'] = media - previousMediaRejected;
        const { rejections, ...roomCounts } = counts;
        log({
            category: 'ops_summary',
            intervalMs,
            capacity: { ...capacity },
            rooms: {
                enabled: rooms.enabled,
                authorityState: rooms.authorityState,
                authorityChanges: Math.max(0, rooms.authorityChanges - previous.authorityChanges),
                lastSuccessfulSweepAgeMs: rooms.lastSuccessfulSweepAgeMs,
                openRooms: rooms.openRooms,
                openSockets: rooms.openSockets,
                ...roomCounts,
                upgradeRejectionsTotal: sum(roomCounts.upgradeRejections),
                ticketFailuresTotal: sum(roomCounts.ticketFailures),
                capacityRejectionsTotal: sum(roomCounts.capacityRejections),
                failures,
                failuresTotal: sum(failures)
            },
            rejections: { total: sum(rejections), byCode: rejections },
            limiters: { total: sum(limiters), byScope: limiters }
        });
        previous = rooms;
        previousMediaRejected = media;
    };

    return {
        flush,
        /** Starts the timer; it never keeps the process alive and stops with the returned function. */
        start() {
            // A diagnostics fault must never become an uncaught exception that restarts the only instance.
            const timer = setInterval(() => { try { flush(); } catch { /* the next interval tries again */ } }, intervalMs);
            timer.unref();
            return () => { clearInterval(timer); };
        }
    };
};
