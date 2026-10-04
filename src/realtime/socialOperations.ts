import { isRoomIdentifier } from '../contracts/roomV1';
import { writeOperationalLog, type OperationalLog } from '../infrastructure/operationalLog';
import { roomGatewayMetrics, type RoomGatewayMetrics } from './roomGatewayMetrics';

/** Close codes grouped by who closed and whether a retry can help; raw reasons are never kept. */
export const socketCloseClasses = ['normal', 'goingAway', 'policy', 'unavailable', 'abnormal'] as const;
/** Why an upgrade was refused before a socket existed. */
export const upgradeRejectionReasons = ['unavailable', 'unauthorized', 'attemptRate', 'pending', 'capacity', 'perAddress', 'perAccount'] as const;
export const ticketFailureKinds = ['capacity', 'perAccount', 'limit', 'session', 'unavailable'] as const;
export const capacityLimits = ['sockets', 'openRooms', 'roomMembers'] as const;
/**
 * `accountLifecycle` covers rooms whose host left through account deactivation, deletion or sign-out
 * everywhere; those closures commit inside other services' transactions, so the next sweep reports them.
 */
export const roomCloseReasons = ['hostEnded', 'hostAbsent', 'hostMissing', 'expired', 'accountLifecycle'] as const;

export type SocketCloseClass = typeof socketCloseClasses[number];
export type UpgradeRejectionReason = typeof upgradeRejectionReasons[number];
export type TicketFailureKind = typeof ticketFailureKinds[number];
export type CapacityLimit = typeof capacityLimits[number];
export type RoomCloseReason = typeof roomCloseReasons[number];
export type RoomTransition = { transition: 'created' | 'suspended'; roomId: string }
    | { transition: 'closed'; roomId: string; reason: RoomCloseReason };

const zeroed = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map(key => [key, 0])) as Record<K, number>;
const increment = <K extends string>(counters: Record<K, number>, key: K) => {
    if (Object.prototype.hasOwnProperty.call(counters, key)) counters[key] = Math.min(Number.MAX_SAFE_INTEGER, counters[key] + 1);
};
const closeClass = (code: number): SocketCloseClass => code === 1000 ? 'normal'
    : code === 1001 ? 'goingAway'
        : [1003, 1007, 1008, 1009].includes(code) ? 'policy'
            : [1011, 1012, 1013].includes(code) ? 'unavailable' : 'abnormal';
/** Rejection codes are code constants; the shape check and key bound keep a mistake from growing memory. */
const rejectionCode = /^[a-z][a-z_]{0,47}$/;
const maximumRejectionCodes = 32;
const recentClosedLimit = 256;

const emptyInterval = () => ({
    socketsOpened: 0, socketsClosed: 0, peakSockets: 0,
    socketCloses: zeroed(socketCloseClasses),
    upgradeRejections: zeroed(upgradeRejectionReasons),
    ticketFailures: zeroed(ticketFailureKinds),
    capacityRejections: zeroed(capacityLimits),
    fanoutPasses: 0, fanoutLagMaxMs: 0,
    roomsCreated: 0, roomsSuspended: 0, roomsClosed: 0,
    rejections: new Map<string, number>()
});

export interface SocialOperationsOptions {
    now?: () => number;
    log?: OperationalLog;
    metrics?: Pick<RoomGatewayMetrics, 'setOpenRooms' | 'openSockets'>;
    /** Minimum spacing between two `social_capacity` lines for the same limit. */
    capacityLogIntervalMs?: number;
}

/**
 * Process-local social and room operations: interval counters for the periodic summary plus the few
 * immediate lines operators alarm on (room lifecycle and reaching a capacity limit). Every label is a fixed
 * enum or a code constant; the only identifier ever written is an opaque room ID.
 */
export const createSocialOperations = (options: SocialOperationsOptions = {}) => {
    const now = options.now ?? Date.now;
    const log = options.log ?? writeOperationalLog;
    const metrics = options.metrics ?? roomGatewayMetrics;
    const capacityLogIntervalMs = options.capacityLogIntervalMs ?? 60_000;
    let interval = emptyInterval();
    const lastCapacityLog = new Map<CapacityLimit, number>();
    let knownOpen: Set<string> | null = null;
    // Closures already reported, and disappearances awaiting one more sweep in case their report is in flight.
    const recentClosed = new Set<string>();
    let unexplained = new Set<string>();

    const reportClosed = (roomId: string, reason: RoomCloseReason) => {
        interval.roomsClosed += 1;
        log({ category: 'room_lifecycle', transition: 'closed', reason, roomId });
    };

    return {
        /** `openSockets` is the count after this socket joined, used for the interval peak. */
        socketOpened(openSockets: number) {
            interval.socketsOpened += 1;
            if (Number.isSafeInteger(openSockets)) interval.peakSockets = Math.max(interval.peakSockets, openSockets);
        },
        socketClosed(code: number) {
            interval.socketsClosed += 1;
            increment(interval.socketCloses, closeClass(code));
        },
        recordUpgradeRejection(reason: UpgradeRejectionReason) { increment(interval.upgradeRejections, reason); },
        recordTicketFailure(kind: TicketFailureKind) { increment(interval.ticketFailures, kind); },
        /** Time from the first change wakeup a fanout pass absorbed until every connection was re-read. */
        recordFanout(lagMs: number) {
            interval.fanoutPasses += 1;
            if (Number.isFinite(lagMs) && lagMs > 0) interval.fanoutLagMaxMs = Math.max(interval.fanoutLagMaxMs, Math.round(lagMs));
        },
        /** Counts every refusal; writes at most one line per limit each minute so a full system cannot flood the log. */
        recordCapacityRejection(limit: CapacityLimit, maximum: number) {
            if (!capacityLimits.includes(limit)) return;
            increment(interval.capacityRejections, limit);
            const at = now();
            const previous = lastCapacityLog.get(limit);
            if (previous !== undefined && at - previous < capacityLogIntervalMs) return;
            lastCapacityLog.set(limit, at);
            log({ category: 'social_capacity', limit, maximum: Number.isSafeInteger(maximum) ? maximum : null });
        },
        /** HTTP 429/503 social and room error codes, plus rejected room command outcomes for limits. */
        recordRejection(code: string) {
            if (!rejectionCode.test(code)) return;
            if (!interval.rejections.has(code) && interval.rejections.size >= maximumRejectionCodes) return;
            interval.rejections.set(code, Math.min(Number.MAX_SAFE_INTEGER, (interval.rejections.get(code) ?? 0) + 1));
        },
        /** Reported only after the transition committed. */
        roomTransition(value: RoomTransition) {
            if (!isRoomIdentifier(value.roomId)) return;
            if (value.transition === 'closed') {
                if (!roomCloseReasons.includes(value.reason)) return;
                // A sweep that already saw the room vanish only waits for this report; otherwise remember it.
                if (!unexplained.delete(value.roomId)) {
                    recentClosed.add(value.roomId);
                    if (recentClosed.size > recentClosedLimit) recentClosed.delete(recentClosed.values().next().value!);
                }
                reportClosed(value.roomId, value.reason);
            } else if (value.transition === 'created') {
                interval.roomsCreated += 1;
                log({ category: 'room_lifecycle', transition: 'created', roomId: value.roomId });
            } else if (value.transition === 'suspended') {
                interval.roomsSuspended += 1;
                log({ category: 'room_lifecycle', transition: 'suspended', roomId: value.roomId });
            }
        },
        /**
         * The sweep's open-room list. Besides the gauge, a room that vanished without a reported closure was
         * closed by an account change in another service's transaction; it is reported one sweep later so a
         * host's End room, whose report follows its commit, is not mistaken for one.
         */
        observeOpenRooms(roomIds: readonly string[]) {
            metrics.setOpenRooms(roomIds.length);
            const current = new Set(roomIds);
            for (const roomId of unexplained) if (!current.has(roomId)) reportClosed(roomId, 'accountLifecycle');
            unexplained = new Set();
            for (const roomId of knownOpen ?? []) {
                if (current.has(roomId)) continue;
                if (recentClosed.has(roomId)) recentClosed.delete(roomId);
                else unexplained.add(roomId);
            }
            knownOpen = current;
        },
        /** Returns this interval's counters and starts the next interval. */
        take() {
            const taken = interval;
            interval = emptyInterval();
            interval.peakSockets = metrics.openSockets();
            const rejections = Object.fromEntries([...taken.rejections].sort(([left], [right]) => left.localeCompare(right)));
            return { ...taken, peakSockets: Math.max(taken.peakSockets, metrics.openSockets()), rejections };
        }
    };
};

export type SocialOperations = ReturnType<typeof createSocialOperations>;
/** The gateway, room service, social routes and the summary share one process registry. */
export const socialOperations = createSocialOperations();
