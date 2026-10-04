import { socialRollout } from '../config/socialRollout';
import { writeOperationalLog, type OperationalLog } from '../infrastructure/operationalLog';

/** Fixed operational categories cannot grow with account, room, session or error values. */
export const roomGatewayFailureCategories = [
    'authorityAcquisition', 'sweep', 'refresh', 'report', 'disconnect'
] as const;
export type RoomGatewayFailure = typeof roomGatewayFailureCategories[number];
/**
 * `ready` belongs to an admitting gateway; `windingDown` means a process that started with rooms switched off
 * holds the authority only to pause and end rooms left open, and returns to `inactive` once none remain.
 */
export type RoomGatewayAuthorityState = 'inactive' | 'starting' | 'ready' | 'windingDown' | 'unavailable' | 'stopped';
const authorityStates: readonly RoomGatewayAuthorityState[] = ['inactive', 'starting', 'ready', 'windingDown', 'unavailable', 'stopped'];
const boundedCount = (value: number) => Number.isSafeInteger(value) && value >= 0 ? value : null;

/**
 * Stores five saturated counters, one state with its change count, two gauges and one local successful-sweep
 * timestamp. A state change writes one `room_authority` line, so lease loss and flapping reach the log
 * without polling `/health`; repeated renewals of the same state stay silent.
 */
export const createRoomGatewayMetrics = (
    now: () => number = Date.now,
    isEnabled: () => boolean = () => socialRollout().roomsEnabled,
    log: OperationalLog = () => undefined
) => {
    const failures: Record<RoomGatewayFailure, number> = {
        authorityAcquisition: 0, sweep: 0, refresh: 0, report: 0, disconnect: 0
    };
    let authorityState: RoomGatewayAuthorityState = 'inactive';
    let authorityChanges = 0;
    let lastSuccessfulSweep: number | null = null;
    let openSockets = 0;
    let openRooms: number | null = null;
    return {
        /** Counts failed operations, accepting no caller-defined labels or error payloads. */
        recordFailure(category: RoomGatewayFailure, count = 1) {
            if (!Object.prototype.hasOwnProperty.call(failures, category)
                || !Number.isSafeInteger(count) || count < 1) return;
            failures[category] = Math.min(Number.MAX_SAFE_INTEGER, failures[category] + count);
        },
        setAuthorityState(state: RoomGatewayAuthorityState) {
            if (!authorityStates.includes(state) || state === authorityState) return;
            authorityState = state;
            authorityChanges = Math.min(Number.MAX_SAFE_INTEGER, authorityChanges + 1);
            log({ category: 'room_authority', state });
        },
        recordSuccessfulSweep() {
            const completedAt = now();
            if (Number.isFinite(completedAt)) lastSuccessfulSweep = completedAt;
        },
        /** Realtime sockets this process currently holds. */
        setOpenSockets(count: number) { openSockets = boundedCount(count) ?? openSockets; },
        /** Open rooms seen by this process's most recent sweep; null until a sweep has read them. */
        setOpenRooms(count: number) { openRooms = boundedCount(count) ?? openRooms; },
        openSockets: () => openSockets,
        /** Copies bounded primitives; consumers cannot mutate the registry or recover identities. */
        snapshot() {
            const age = lastSuccessfulSweep === null ? null : now() - lastSuccessfulSweep;
            return {
                scope: 'process' as const,
                // Rollout admission can be disabled while a gateway or a wind-down still owns the lease.
                enabled: isEnabled() === true,
                authorityState,
                authorityChanges,
                lastSuccessfulSweepAgeMs: age === null || !Number.isFinite(age)
                    ? null : Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(age))),
                openSockets,
                openRooms,
                failures: { ...failures }
            };
        }
    };
};

export type RoomGatewayMetrics = ReturnType<typeof createRoomGatewayMetrics>;
/** The installed production gateway, the health handler and the periodic summary observe the same registry. */
export const roomGatewayMetrics = createRoomGatewayMetrics(undefined, undefined, writeOperationalLog);
