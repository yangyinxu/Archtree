import type { Server, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Socket } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { createRoomService } from '../application/rooms/roomService';
import { exactSocialKeys, SocialError } from '../contracts/socialV1';
import { parseRoomHeartbeat, parseRoomReady, ROOM_LIMITS, type RoomActor, type RoomApi } from '../contracts/roomV1';
import { admitRealtimeSeat, generalRealtimeSeats, realtimeSeatRefusal, socialCapacity, type RealtimeSeatState, type SocialCapacity } from '../config/socialCapacity';
import { socialRollout } from '../config/socialRollout';
import { getDb } from '../infrastructure/database';
import type { ServerLifecycle } from '../services/serverLifecycleService';
import { roomAuthority } from './roomAuthority';
import { roomGatewayMetrics, type RoomGatewayMetrics } from './roomGatewayMetrics';
import { onRoomChanges } from './roomEvents';
import { realtimeSeats } from './realtimeSeats';
import { isRoomParticipant, redeemRoomTicket } from './roomTickets';
import { createRoomUpgradeContext, createRoomUpgradeRateLimit } from './roomUpgradeProtection';
import { socialOperations, type SocialOperations, type UpgradeRejectionReason } from './socialOperations';

/** `inRoom` is the account's room membership as this socket's latest read (or its admission lookup) saw it. */
interface Connection { socket: WebSocket; actor: RoomActor; key: string; ip: string; version: string;
    lastSeen: number; lastHeartbeat: number; heartbeatState: string; window: number; reports: number; pending: number; socialVersion: number;
    inRoom: boolean }
interface GatewayOptions { api?: RoomApi; acquire?: typeof roomAuthority.acquire; release?: typeof roomAuthority.release;
    redeemTicket?: typeof redeemRoomTicket; metrics?: RoomGatewayMetrics; operations?: SocialOperations;
    /** Resolved once at install, like the rollout flags: changing it restarts the process. */
    capacity?: SocialCapacity; isRoomMember?: (accountId: string) => Promise<boolean>; seats?: typeof realtimeSeats;
    /** Waits out one repair backoff; tests observe the requested delay instead of measuring the wall clock. */
    sleep?: (ms: number) => Promise<void> }
/** The per-address bound stays fixed; process and per-account socket bounds follow deployment capacity. */
const SOCKETS_PER_ADDRESS = 32;
const PENDING_UPGRADES = 32;
const connectionKey = (actor: RoomActor) => `${actor.userId}:${actor.sessionId}:${actor.clientId}`;

/** Authenticated complete-state delivery; commands stay on HTTP and media bytes stay on the stream route. */
export const installRoomGateway = (server: Server, lifecycle: ServerLifecycle, options: GatewayOptions = {}) => {
    const api = options.api ?? createRoomService();
    const metrics = options.metrics ?? roomGatewayMetrics;
    const operations = options.operations ?? socialOperations;
    const capacity = options.capacity ?? socialCapacity();
    const isRoomMember = options.isRoomMember ?? isRoomParticipant;
    const seats = options.seats ?? realtimeSeats;
    metrics.setAuthorityState('starting');
    metrics.setOpenSockets(0);
    const acquire = options.acquire ?? (() => roomAuthority.acquire());
    const release = options.release ?? (() => roomAuthority.release());
    const redeemTicket = options.redeemTicket ?? redeemRoomTicket;
    const upgradeContext = createRoomUpgradeContext();
    const allowUpgradeAttempt = createRoomUpgradeRateLimit();
    const enabled = () => socialRollout().roomsEnabled;
    const wss = new WebSocketServer({ noServer: true, maxPayload: 2_048, perMessageDeflate: false,
        handleProtocols: protocols => protocols.has('archtree-room-v1') ? 'archtree-room-v1' : false });
    const connections = new Map<string, Connection>();

    /** Closing sockets no longer hold a seat; their close event follows shortly. */
    const seatState = (actor: RoomActor): RealtimeSeatState => {
        const members = new Set<string>();
        let openSockets = 0, accountSockets = 0, accountIsMember = false;
        for (const value of connections.values()) {
            if (value.socket.readyState !== WebSocket.OPEN) continue;
            openSockets += 1;
            if (value.inRoom) members.add(value.actor.userId);
            if (value.actor.userId === actor.userId) { accountSockets += 1; accountIsMember ||= value.inRoom; }
        }
        return { replacing: connections.has(connectionKey(actor)), openSockets, memberAccounts: members.size, accountSockets, accountIsMember };
    };
    const admission = (actor: RoomActor) => admitRealtimeSeat(() => seatState(actor), capacity, () => isRoomMember(actor.userId));
    const uninstallSeats = seats.install(async actor => (await admission(actor)).refusal);
    /** Sockets beyond the reserved members' first sockets; above the general seats only after membership ended. */
    const generalOverfull = (actor: RoomActor) => {
        const state = seatState(actor);
        const general = generalRealtimeSeats(capacity);
        return state.openSockets - Math.min(state.memberAccounts, capacity.maxRealtimeSockets - general) > general;
    };
    const chains = new Map<string, Promise<unknown>>();
    let pendingUpgrades = 0;
    let stopped = false;
    let refreshPending = false;
    let refreshing = false;
    let ticking = false;
    let lastLease = 0;
    let lastRecovery = 0;
    let authorityReady = false;
    let sweepFailures = 0;
    let fanoutRequestedAt: number | null = null;

    /** Observe lease acquisition without changing its scheduling or retry policy. */
    const acquireAuthority = async () => {
        try {
            authorityReady = (await acquire()) !== null;
            if (!authorityReady) metrics.recordFailure('authorityAcquisition');
            if (!stopped) metrics.setAuthorityState(authorityReady ? 'ready' : 'unavailable');
        } catch (error) {
            metrics.recordFailure('authorityAcquisition');
            if (!stopped) metrics.setAuthorityState('unavailable');
            throw error;
        }
    };

    const unavailable = (error: unknown): error is SocialError => error instanceof SocialError && error.statusCode === 503
        && ['room_unavailable', 'social_unavailable'].includes(error.code);
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); }));
    const backoff = (attempt: number) => sleep((attempt + 1) * 100 + Math.floor(Math.random() * 40));
    const closeForFailure = (connection: Connection, error: unknown) => {
        if (error instanceof SocialError && error.statusCode < 500) connection.socket.close(1008, 'Session unavailable.');
        else if (error instanceof SocialError && ['room_authority_unavailable', 'rooms_disabled'].includes(error.code)) connection.socket.close(1012, 'Authority unavailable.');
        else connection.socket.close(1013, 'Synchronization temporarily unavailable.');
    };

    const send = (connection: Connection, value: unknown) => {
        if (stopped || connections.get(connection.key) !== connection || connection.socket.readyState !== WebSocket.OPEN) return;
        const encoded = JSON.stringify(value);
        if (Buffer.byteLength(encoded) > ROOM_LIMITS.snapshotBytes || connection.socket.bufferedAmount > 2 * ROOM_LIMITS.snapshotBytes) {
            connection.socket.close(1013, 'Reconnect to synchronize.'); return;
        }
        connection.socket.send(encoded, error => { if (error) connection.socket.terminate(); });
    };
    // Connect, readiness, heartbeat and final close share a per-client queue, including replaced sockets.
    const serialized = <T>(key: string, operation: () => Promise<T>): Promise<T> => {
        const prior = chains.get(key) ?? Promise.resolve();
        const work = prior.catch(() => undefined).then(() => lifecycle.track(operation));
        chains.set(key, work);
        void work.finally(() => { if (chains.get(key) === work) chains.delete(key); }).catch(() => undefined);
        return work;
    };
    const refresh = async (connection: Connection, subscribed = false) => {
        if (stopped || connections.get(connection.key) !== connection) return;
        try {
            let resolved: { room: Awaited<ReturnType<RoomApi['currentRoom']>>; socialVersion: number } | undefined;
            // Re-read authorization after a bounded availability failure. No user command,
            // stale projection, or assumed-valid session is replayed during this repair.
            for (let attempt = 0; attempt < 3; attempt += 1) {
                if (stopped || connections.get(connection.key) !== connection || connection.socket.readyState !== WebSocket.OPEN) return;
                try {
                    const room = await api.currentRoom(connection.actor);
                    const social = await getDb()!.collection('socialOutbox').findOne({ _id: connection.actor.userId as never }, { projection: { revision: 1 } });
                    resolved = { room, socialVersion: Number(social?.revision ?? 0) };
                    break;
                } catch (error) {
                    const repairable = error instanceof SocialError && error.statusCode === 503
                        && ['room_unavailable', 'social_unavailable', 'mutation_outcome_unknown'].includes(error.code);
                    if (!repairable || attempt === 2) throw error;
                    await backoff(attempt);
                }
            }
            if (!resolved) return;
            const { room, socialVersion } = resolved;
            if (connections.get(connection.key) !== connection) return;
            const wasInRoom = connection.inRoom;
            connection.inRoom = room !== null;
            // A socket seated as a room member gives its seat back once the account left every room, but only
            // while the general seats are over-full. It still delivers the absence first; the tab then waits for
            // a seat like any other.
            const release = wasInRoom && room === null && generalOverfull(connection.actor);
            const version = room ? `${room.roomId}:${room.epoch}:${room.revision}:${room.self.controllerGeneration}:${room.self.isController}` : 'none';
            if (subscribed) send(connection, { type: 'subscribed', protocolVersion: 1, serverTimeMs: Date.now(), room });
            // HTTP may have observed a brief membership that was coalesced away on this socket.
            // Reaffirming absence prevents that HTTP state surviving a later kick/block/end.
            else if (room === null || version !== connection.version) send(connection, { type: 'snapshot', room });
            connection.version = version;
            if (socialVersion !== connection.socialVersion) { connection.socialVersion = socialVersion; send(connection, { type: 'socialChanged' }); }
            if (release) connection.socket.close(1013, 'Live updates are busy.');
        } catch (error) {
            metrics.recordFailure('refresh');
            closeForFailure(connection, error);
        }
    };
    /**
     * Coalesce wakeups; each send resolves fresh viewer/session authorization after the committing transaction.
     * A pass's lag runs from the earliest wakeup it absorbed, so queued wakeups count the wait for the running pass.
     */
    const fanout = () => {
        refreshPending = true;
        fanoutRequestedAt ??= Date.now();
        if (refreshing || stopped) return;
        refreshing = true;
        void lifecycle.track(async () => {
            while (refreshPending && !stopped) {
                refreshPending = false;
                const requestedAt = fanoutRequestedAt ?? Date.now();
                fanoutRequestedAt = null;
                const current = [...connections.values()];
                for (let i = 0; i < current.length && !stopped; i += 8) {
                    await Promise.all(current.slice(i, i + 8).map(connection => serialized(connection.key, () => refresh(connection)).catch(() => { metrics.recordFailure('refresh'); })));
                }
                if (!stopped) operations.recordFanout(Date.now() - requestedAt);
            }
        }).catch(() => { metrics.recordFailure('refresh'); }).finally(() => { refreshing = false; });
    };
    const unsubscribe = onRoomChanges(fanout);

    /** Retry only aborted observation reports with their original immutable identity, never HTTP commands. */
    const dispatchReport = async (connection: Connection, operation: () => Promise<void>): Promise<boolean> => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
            if (stopped || connections.get(connection.key) !== connection || connection.socket.readyState !== WebSocket.OPEN) return false;
            try { await operation(); return true; }
            catch (error) {
                if (error instanceof SocialError && ((error.statusCode === 409 && error.code === 'stale_controller')
                    || (error.statusCode === 404 && ['room_unavailable', 'room_media_unavailable'].includes(error.code)))) {
                    // A controller/membership change invalidates this report, not the authenticated observer socket.
                    await refresh(connection); return false;
                }
                if (!unavailable(error) || attempt === 2) throw error;
                await backoff(attempt);
            }
        }
        return false;
    };

    const dispatch = async (connection: Connection, bytes: Buffer, binary: boolean) => {
        if (connections.get(connection.key) !== connection || stopped) return;
        if (binary) { connection.socket.close(1003, 'JSON required.'); return; }
        let value: unknown;
        try { value = JSON.parse(bytes.toString('utf8')); } catch { connection.socket.close(1007, 'Invalid JSON.'); return; }
        const now = Date.now();
        const minute = Math.floor(now / 60_000);
        if (connection.window !== minute) { connection.window = minute; connection.reports = 0; }
        if (++connection.reports > 120) { connection.socket.close(1008, 'Report limit.'); return; }
        if (exactSocialKeys(value, ['type', 'clientTimeMs', 'heartbeat']) && value.type === 'ping'
            && typeof value.clientTimeMs === 'number' && Number.isFinite(value.clientTimeMs) && value.clientTimeMs >= 0) {
            const report = value.heartbeat === null ? null : parseRoomHeartbeat(value.heartbeat);
            if (value.heartbeat !== null && !report) { connection.socket.close(1008, 'Invalid heartbeat.'); return; }
            connection.lastSeen = now;
            const heartbeatState = JSON.stringify(report);
            if (report && (now - connection.lastHeartbeat >= 4_000 || connection.heartbeatState !== heartbeatState)) {
                // The domain wakes viewers only for visible committed changes; liveness writes do not fan out.
                if (await dispatchReport(connection, () => api.heartbeat(connection.actor, report))) {
                    connection.lastHeartbeat = now;
                    connection.heartbeatState = heartbeatState;
                }
            }
            send(connection, { type: 'pong', clientTimeMs: value.clientTimeMs, serverTimeMs: Date.now() });
        } else if (exactSocialKeys(value, ['type', 'report']) && value.type === 'ready') {
            const report = parseRoomReady(value.report);
            if (!report) { connection.socket.close(1008, 'Invalid readiness.'); return; }
            await dispatchReport(connection, () => api.ready(connection.actor, report));
        } else connection.socket.close(1008, 'Unsupported message.');
    };

    const connect = (socket: WebSocket, actor: RoomActor, ip: string, inRoom: boolean) => {
        const key = connectionKey(actor);
        const previous = connections.get(key);
        const connection: Connection = { socket, actor, key, ip, version: '', lastSeen: Date.now(), lastHeartbeat: 0, heartbeatState: '',
            window: 0, reports: 0, pending: 0, socialVersion: -1, inRoom: inRoom || previous?.inRoom === true };
        connections.set(key, connection);
        metrics.setOpenSockets(connections.size);
        operations.socketOpened(connections.size);
        previous?.socket.close(1000, 'Connection replaced.');
        socket.on('error', () => { socket.terminate(); });
        socket.on('close', (code: number) => {
            operations.socketClosed(code);
            if (connections.get(key) !== connection) return;
            connections.delete(key);
            metrics.setOpenSockets(connections.size);
            if (!stopped) void serialized(key, async () => {
                if (!connections.has(key)) await api.disconnected(actor);
            }).catch(() => { metrics.recordFailure('disconnect'); });
        });
        socket.on('message', (bytes, binary) => {
            if (++connection.pending > 8) { socket.close(1008, 'Too many pending reports.'); return; }
            void serialized(key, () => dispatch(connection, Buffer.from(bytes as ArrayBuffer), binary))
                .catch(error => { metrics.recordFailure('report'); closeForFailure(connection, error); })
                .finally(() => { connection.pending--; });
        });
        void serialized(key, () => refresh(connection, true)).catch(() => { metrics.recordFailure('refresh'); socket.close(1011, 'Unavailable.'); });
    };
    const reject = (socket: Duplex, status: number, reason: UpgradeRejectionReason) => {
        operations.recordUpgradeRejection(reason);
        if (reason === 'capacity') operations.recordCapacityRejection('sockets', capacity.maxRealtimeSockets);
        if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    const fromAddress = (ip: string) => [...connections.values()].filter(value => value.ip === ip).length;
    const upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        // Upgrade sockets no longer have Express's request error handling while ticket IO is pending.
        const onSocketError = () => socket.destroy();
        socket.on('error', onSocketError);
        if (req.url !== '/api/social/v1/realtime' || stopped || lifecycle.draining || !authorityReady || !enabled()) return reject(socket, 503, 'unavailable');
        const { ip, secure } = upgradeContext(req);
        if (!allowUpgradeAttempt(ip)) return reject(socket, 429, 'attemptRate');
        if (pendingUpgrades >= PENDING_UPGRADES) return reject(socket, 429, 'pending');
        // The socket cap waits for the ticket's identity, because replacing this client's own socket needs no seat.
        if (fromAddress(ip) >= SOCKETS_PER_ADDRESS) return reject(socket, 429, 'perAddress');
        const origin = req.headers.origin;
        const protocols = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map(value => value.trim());
        if (!origin || protocols.length !== 2 || protocols[0] !== 'archtree-room-v1' || !/^[A-Za-z0-9_-]{43}$/.test(protocols[1])) return reject(socket, 401, 'unauthorized');
        try {
            const parsed = new URL(origin);
            if (parsed.origin !== origin || parsed.host !== req.headers.host || !['http:', 'https:'].includes(parsed.protocol)) return reject(socket, 403, 'unauthorized');
            if (process.env.NODE_ENV === 'production' && (!secure || parsed.protocol !== 'https:')) return reject(socket, 426, 'unauthorized');
        } catch { return reject(socket, 403, 'unauthorized'); }
        pendingUpgrades++;
        (socket as Socket).setTimeout(5_000, () => socket.destroy());
        void lifecycle.track(async () => {
            const actor = await redeemTicket(protocols[1], origin);
            if (!actor) return reject(socket, 401, 'unauthorized');
            // Ticket IO and the member lookup both yield, so every bound is rechecked against current sockets.
            const refusal = (): UpgradeRejectionReason | null => {
                if (stopped || lifecycle.draining || socket.destroyed || !authorityReady || !enabled()) return 'unavailable';
                return fromAddress(ip) >= SOCKETS_PER_ADDRESS ? 'perAddress' : null;
            };
            let refused = refusal();
            let inRoom = false;
            if (!refused) {
                inRoom = (await admission(actor)).member;
                // The membership lookup (and the await itself) yields, so the seat is judged again synchronously
                // against current sockets; nothing yields between this judgment and the connection joining them.
                const state = seatState(actor);
                refused = refusal() ?? realtimeSeatRefusal(state, capacity, inRoom || state.accountIsMember);
            }
            // A lost race with shutdown or rollout keeps the original empty 401; every bound is a 429.
            if (refused) return reject(socket, refused === 'unavailable' ? 401 : 429, refused);
            (socket as Socket).setTimeout(0);
            wss.handleUpgrade(req, socket, head, webSocket => {
                connect(webSocket, actor, ip, inRoom);
                socket.off('error', onSocketError);
            });
        }).catch(() => reject(socket, 401, 'unavailable')).finally(() => { pendingUpgrades--; });
    };
    server.on('upgrade', upgrade);

    /** Periodic current-state reads repair lost final fanout; durable timers remain in MongoDB. */
    const tick = async () => {
        if (stopped || ticking) return;
        ticking = true;
        try {
            await lifecycle.track(async () => {
                const now = Date.now();
                if (now - lastLease >= 3_000) { await acquireAuthority(); lastLease = now; }
                if (!authorityReady) {
                    for (const connection of connections.values()) connection.socket.close(1012, 'Authority changed.');
                    return;
                }
                try { await api.sweep(); sweepFailures = 0; metrics.recordSuccessfulSweep(); }
                catch (error) {
                    metrics.recordFailure('sweep');
                    if (!unavailable(error) || ++sweepFailures >= 3) throw error;
                    // A known-aborted timer does not prove lease loss. Revalidate authority now,
                    // then let the next ordinary tick capture a new, independently fenced observation.
                    await acquireAuthority(); lastLease = Date.now();
                    if (!authorityReady) throw new SocialError(503, 'room_authority_unavailable');
                    return;
                }
                if (now - lastRecovery >= 5_000) { lastRecovery = now; fanout(); }
                for (const connection of connections.values()) {
                    if (now - connection.lastSeen > 16_000 || !enabled()) connection.socket.close(1001, 'Reconnect to synchronize.');
                }
            });
        } catch (error) {
            authorityReady = false;
            if (!stopped) metrics.setAuthorityState('unavailable');
            const temporary = unavailable(error) || (error instanceof SocialError && error.code === 'mutation_outcome_unknown');
            for (const connection of connections.values()) connection.socket.close(temporary ? 1013 : 1012, 'Synchronization unavailable.');
        }
        finally { ticking = false; }
    };
    const interval = setInterval(() => { void tick(); }, 250);
    interval.unref();
    void tick();

    /** Stop admission and socket callbacks before draining; release only this process's matching lease last. */
    const stop = () => {
        if (stopped) return;
        stopped = true; metrics.setAuthorityState('stopped'); clearInterval(interval); unsubscribe(); uninstallSeats();
        server.off('upgrade', upgrade);
        for (const connection of connections.values()) connection.socket.terminate();
        connections.clear(); metrics.setOpenSockets(0); wss.close();
    };
    lifecycle.onDrain(stop);
    server.once('close', stop);
    return { stop, release };
};
