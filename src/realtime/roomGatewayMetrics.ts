/** Fixed operational categories cannot grow with account, room, session or error values. */
export const roomGatewayFailureCategories = [
    'authorityAcquisition', 'sweep', 'refresh', 'report', 'disconnect'
] as const;
export type RoomGatewayFailure = typeof roomGatewayFailureCategories[number];
export type RoomGatewayAuthorityState = 'starting' | 'ready' | 'unavailable' | 'stopped';
const authorityStates: readonly RoomGatewayAuthorityState[] = ['starting', 'ready', 'unavailable', 'stopped'];

/** Stores only five saturated counters, one state and one local successful-sweep timestamp. */
export const createRoomGatewayMetrics = (now: () => number = Date.now) => {
    const failures: Record<RoomGatewayFailure, number> = {
        authorityAcquisition: 0, sweep: 0, refresh: 0, report: 0, disconnect: 0
    };
    let authorityState: RoomGatewayAuthorityState = 'starting';
    let lastSuccessfulSweep: number | null = null;
    return {
        /** Counts failed operations, accepting no caller-defined labels or error payloads. */
        recordFailure(category: RoomGatewayFailure, count = 1) {
            if (!Object.prototype.hasOwnProperty.call(failures, category)
                || !Number.isSafeInteger(count) || count < 1) return;
            failures[category] = Math.min(Number.MAX_SAFE_INTEGER, failures[category] + count);
        },
        setAuthorityState(state: RoomGatewayAuthorityState) {
            if (authorityStates.includes(state)) authorityState = state;
        },
        recordSuccessfulSweep() {
            const completedAt = now();
            if (Number.isFinite(completedAt)) lastSuccessfulSweep = completedAt;
        },
        /** Copies bounded primitives; consumers cannot mutate the registry or recover identities. */
        snapshot() {
            const age = lastSuccessfulSweep === null ? null : now() - lastSuccessfulSweep;
            return {
                scope: 'process' as const,
                authorityState,
                lastSuccessfulSweepAgeMs: age === null || !Number.isFinite(age)
                    ? null : Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(age))),
                failures: { ...failures }
            };
        }
    };
};

export type RoomGatewayMetrics = ReturnType<typeof createRoomGatewayMetrics>;
/** The installed production gateway and health handler observe the same process registry. */
export const roomGatewayMetrics = createRoomGatewayMetrics();
