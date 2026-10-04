import { ROOM_LIMITS } from '../contracts/roomV1';

/** One process never holds more realtime sockets than this, whatever the configuration says. */
export const REALTIME_SOCKET_CEILING = 256;

/**
 * Deployment capacity for rooms and their realtime connections. The product maximums (100 open rooms,
 * eight members, 256 sockets) are the defaults and the ceilings; a deployment on a small instance or a
 * rate-limited database lowers them through the environment. Lowering a limit only refuses new rooms,
 * joins and connections: rooms, members and sockets already admitted stay.
 */
export interface SocialCapacity {
    maxOpenRooms: number;
    maxRoomMembers: number;
    maxRealtimeSockets: number;
}

const settings = [
    { key: 'maxOpenRooms', variable: 'FINITUDE_ROOMS_MAX_OPEN', minimum: 1, maximum: ROOM_LIMITS.activeRooms },
    { key: 'maxRoomMembers', variable: 'FINITUDE_ROOM_MAX_MEMBERS', minimum: 2, maximum: ROOM_LIMITS.members },
    { key: 'maxRealtimeSockets', variable: 'FINITUDE_REALTIME_MAX_SOCKETS', minimum: 1, maximum: REALTIME_SOCKET_CEILING }
] as const;

/**
 * Reads the capacity variables. A value that is not a whole number falls back to the product ceiling, and a
 * whole number outside the supported range is clamped into it; both are reported by variable name (never by
 * value) so the startup log can flag the mistake without failing the release over an optional limit.
 */
export const resolveSocialCapacity = (environment: NodeJS.ProcessEnv = process.env) => {
    const capacity = {} as SocialCapacity;
    const invalid: string[] = [];
    for (const { key, variable, minimum, maximum } of settings) {
        const raw = environment[variable]?.trim();
        if (!raw) { capacity[key] = maximum; continue; }
        const parsed = /^\d{1,6}$/.test(raw) ? Number(raw) : Number.NaN;
        if (!Number.isSafeInteger(parsed)) { capacity[key] = maximum; invalid.push(variable); continue; }
        capacity[key] = Math.min(maximum, Math.max(minimum, parsed));
        if (capacity[key] !== parsed) invalid.push(variable);
    }
    return { capacity, invalid };
};

/** The effective capacity of this process environment. */
export const socialCapacity = (environment: NodeJS.ProcessEnv = process.env): SocialCapacity =>
    resolveSocialCapacity(environment).capacity;

/**
 * Seats that every socket may use. The remaining seats, one per member of every allowed room but never more
 * than half of all sockets, hold each connected room member's first socket, so tabs outside rooms (and a
 * member's extra tabs) can never take the seat a member needs for shared playback.
 */
export const generalRealtimeSeats = (capacity: SocialCapacity) => capacity.maxRealtimeSockets
    - Math.min(capacity.maxOpenRooms * capacity.maxRoomMembers, Math.floor(capacity.maxRealtimeSockets / 2));

/** No account holds more realtime sockets than this in one process, room member or not. */
export const REALTIME_SOCKETS_PER_ACCOUNT = 4;

/**
 * General seats one account may hold: a quarter of them, between one and the per-account maximum, so a few
 * accounts' tabs cannot fill the general seats. A room member's first socket does not count against it.
 */
export const realtimeSocketsPerAccount = (capacity: SocialCapacity) =>
    Math.min(REALTIME_SOCKETS_PER_ACCOUNT, Math.max(1, Math.floor(generalRealtimeSeats(capacity) / 4)));

export type RealtimeSeatRefusal = 'capacity' | 'perAccount';

/** What a process knows about its open sockets when one more asks for a seat. */
export interface RealtimeSeatState {
    /** The connection replaces this client's own socket, so it takes no new seat. */
    replacing: boolean;
    openSockets: number;
    /** Connected accounts that are currently in a room. */
    memberAccounts: number;
    /** Sockets the asking account already holds. */
    accountSockets: number;
    /** The asking account is already counted in `memberAccounts`. */
    accountIsMember: boolean;
}

/**
 * Judges the state after admitting one more socket. Up to the reserved count, each connected member's first
 * socket takes a reserved seat; every other socket takes a general seat. While fewer members than reserved
 * seats are connected, a member without a socket therefore always finds one.
 */
export const realtimeSeatRefusal = (state: RealtimeSeatState, capacity: SocialCapacity, member: boolean): RealtimeSeatRefusal | null => {
    if (state.replacing) return null;
    const sockets = state.openSockets + 1;
    const accountSockets = state.accountSockets + 1;
    const members = state.memberAccounts + (member && !state.accountIsMember ? 1 : 0);
    const general = generalRealtimeSeats(capacity);
    if (accountSockets > REALTIME_SOCKETS_PER_ACCOUNT) return 'perAccount';
    if (sockets > capacity.maxRealtimeSockets) return 'capacity';
    if (accountSockets - (member ? 1 : 0) > realtimeSocketsPerAccount(capacity)) return 'perAccount';
    return sockets - Math.min(members, capacity.maxRealtimeSockets - general) > general ? 'capacity' : null;
};

/**
 * Shared admission rule for ticket issuance and the upgrade itself. Room membership is looked up only when it
 * could change the outcome, and the state is read again after the lookup yields.
 */
export const admitRealtimeSeat = async (read: () => RealtimeSeatState, capacity: SocialCapacity,
    isRoomMember: () => Promise<boolean>): Promise<{ refusal: RealtimeSeatRefusal | null; member: boolean }> => {
    const state = read();
    const refusal = realtimeSeatRefusal(state, capacity, state.accountIsMember);
    if (!refusal || state.accountIsMember || realtimeSeatRefusal(state, capacity, true)) return { refusal, member: state.accountIsMember };
    // An unavailable lookup cannot prove membership, so the general rule still applies to it.
    const looked = await Promise.resolve().then(isRoomMember).then(value => value === true, () => false);
    const after = read();
    const member = looked || after.accountIsMember;
    return { refusal: realtimeSeatRefusal(after, capacity, member), member };
};
