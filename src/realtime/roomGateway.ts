import type { Server, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Socket } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { createRoomService } from '../application/rooms/roomService';
import { exactSocialKeys, SocialError } from '../contracts/socialV1';
import { parseRoomHeartbeat, parseRoomReady, ROOM_LIMITS, type RoomActor, type RoomApi } from '../contracts/roomV1';
import { getDb } from '../infrastructure/database';
import type { ServerLifecycle } from '../services/serverLifecycleService';
import { roomAuthority } from './roomAuthority';
import { onRoomChanges } from './roomEvents';
import { redeemRoomTicket } from './roomTickets';
import { createRoomUpgradeContext, createRoomUpgradeRateLimit } from './roomUpgradeProtection';

interface Connection { socket: WebSocket; actor: RoomActor; key: string; ip: string; version: string;
    lastSeen: number; lastHeartbeat: number; heartbeatState: string; window: number; reports: number; pending: number; socialVersion: number }
interface GatewayOptions { api?: RoomApi; acquire?: typeof roomAuthority.acquire; release?: typeof roomAuthority.release;
    redeemTicket?: typeof redeemRoomTicket }

/** Authenticated complete-state delivery; commands stay on HTTP and media bytes stay on the stream route. */
export const installRoomGateway = (server: Server, lifecycle: ServerLifecycle, options: GatewayOptions = {}) => {
    const api = options.api ?? createRoomService();
    const acquire = options.acquire ?? (() => roomAuthority.acquire());
    const release = options.release ?? (() => roomAuthority.release());
    const redeemTicket = options.redeemTicket ?? redeemRoomTicket;
    const upgradeContext = createRoomUpgradeContext();
    const allowUpgradeAttempt = createRoomUpgradeRateLimit();
    const enabled = () => process.env.FINITUDE_SOCIAL_ENABLED === 'true' && process.env.FINITUDE_ROOMS_ENABLED === 'true';
    const wss = new WebSocketServer({ noServer: true, maxPayload: 2_048, perMessageDeflate: false,
        handleProtocols: protocols => protocols.has('archtree-room-v1') ? 'archtree-room-v1' : false });
    const connections = new Map<string, Connection>();
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

    const unavailable = (error: unknown): error is SocialError => error instanceof SocialError && error.statusCode === 503
        && ['room_unavailable', 'social_unavailable'].includes(error.code);
    const backoff = (attempt: number) => new Promise(resolve => setTimeout(resolve, (attempt + 1) * 100 + Math.floor(Math.random() * 40)));
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
            const version = room ? `${room.roomId}:${room.epoch}:${room.revision}:${room.self.controllerGeneration}:${room.self.isController}` : 'none';
            if (subscribed) send(connection, { type: 'subscribed', protocolVersion: 1, serverTimeMs: Date.now(), room });
            // HTTP may have observed a brief membership that was coalesced away on this socket.
            // Reaffirming absence prevents that HTTP state surviving a later kick/block/end.
            else if (room === null || version !== connection.version) send(connection, { type: 'snapshot', room });
            connection.version = version;
            if (socialVersion !== connection.socialVersion) { connection.socialVersion = socialVersion; send(connection, { type: 'socialChanged' }); }
        } catch (error) {
            closeForFailure(connection, error);
        }
    };
    /** Coalesce wakeups; each send resolves fresh viewer/session authorization after the committing transaction. */
    const fanout = () => {
        refreshPending = true;
        if (refreshing || stopped) return;
        refreshing = true;
        void lifecycle.track(async () => {
            while (refreshPending && !stopped) {
                refreshPending = false;
                const current = [...connections.values()];
                for (let i = 0; i < current.length && !stopped; i += 8) {
                    await Promise.all(current.slice(i, i + 8).map(connection => serialized(connection.key, () => refresh(connection)).catch(() => undefined)));
                }
            }
        }).catch(() => undefined).finally(() => { refreshing = false; });
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

    const connect = (socket: WebSocket, actor: RoomActor, ip: string) => {
        const key = `${actor.userId}:${actor.sessionId}:${actor.clientId}`;
        const previous = connections.get(key);
        const connection: Connection = { socket, actor, key, ip, version: '', lastSeen: Date.now(), lastHeartbeat: 0, heartbeatState: '',
            window: 0, reports: 0, pending: 0, socialVersion: -1 };
        connections.set(key, connection);
        previous?.socket.close(1000, 'Connection replaced.');
        socket.on('error', () => { socket.terminate(); });
        socket.on('close', () => {
            if (connections.get(key) !== connection) return;
            connections.delete(key);
            if (!stopped) void serialized(key, async () => {
                if (!connections.has(key)) await api.disconnected(actor);
            }).catch(() => undefined);
        });
        socket.on('message', (bytes, binary) => {
            if (++connection.pending > 8) { socket.close(1008, 'Too many pending reports.'); return; }
            void serialized(key, () => dispatch(connection, Buffer.from(bytes as ArrayBuffer), binary))
                .catch(error => closeForFailure(connection, error))
                .finally(() => { connection.pending--; });
        });
        void serialized(key, () => refresh(connection, true)).catch(() => socket.close(1011, 'Unavailable.'));
    };
    const reject = (socket: Duplex, status = 401) => {
        if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    const upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        // Upgrade sockets no longer have Express's request error handling while ticket IO is pending.
        const onSocketError = () => socket.destroy();
        socket.on('error', onSocketError);
        if (req.url !== '/api/social/v1/realtime' || stopped || lifecycle.draining || !authorityReady || !enabled()) return reject(socket, 503);
        const { ip, secure } = upgradeContext(req);
        if (!allowUpgradeAttempt(ip) || pendingUpgrades >= 32 || connections.size >= 256
            || [...connections.values()].filter(value => value.ip === ip).length >= 32) return reject(socket, 429);
        const origin = req.headers.origin;
        const protocols = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map(value => value.trim());
        if (!origin || protocols.length !== 2 || protocols[0] !== 'archtree-room-v1' || !/^[A-Za-z0-9_-]{43}$/.test(protocols[1])) return reject(socket);
        try {
            const parsed = new URL(origin);
            if (parsed.origin !== origin || parsed.host !== req.headers.host || !['http:', 'https:'].includes(parsed.protocol)) return reject(socket, 403);
            if (process.env.NODE_ENV === 'production' && (!secure || parsed.protocol !== 'https:')) return reject(socket, 426);
        } catch { return reject(socket, 403); }
        pendingUpgrades++;
        (socket as Socket).setTimeout(5_000, () => socket.destroy());
        void lifecycle.track(async () => {
            const actor = await redeemTicket(protocols[1], origin);
            if (!actor || stopped || lifecycle.draining || socket.destroyed || !authorityReady || !enabled()) return reject(socket);
            if (connections.size >= 256 || [...connections.values()].filter(value => value.ip === ip).length >= 32) return reject(socket, 429);
            if ([...connections.values()].filter(value => value.actor.userId === actor.userId).length >= 4
                && !connections.has(`${actor.userId}:${actor.sessionId}:${actor.clientId}`)) return reject(socket, 429);
            (socket as Socket).setTimeout(0);
            wss.handleUpgrade(req, socket, head, webSocket => {
                connect(webSocket, actor, ip);
                socket.off('error', onSocketError);
            });
        }).catch(() => reject(socket)).finally(() => { pendingUpgrades--; });
    };
    server.on('upgrade', upgrade);

    /** Periodic current-state reads repair lost final fanout; durable timers remain in MongoDB. */
    const tick = async () => {
        if (stopped || ticking) return;
        ticking = true;
        try {
            await lifecycle.track(async () => {
                const now = Date.now();
                if (now - lastLease >= 3_000) { authorityReady = (await acquire()) !== null; lastLease = now; }
                if (!authorityReady) {
                    for (const connection of connections.values()) connection.socket.close(1012, 'Authority changed.');
                    return;
                }
                try { await api.sweep(); sweepFailures = 0; }
                catch (error) {
                    if (!unavailable(error) || ++sweepFailures >= 3) throw error;
                    // A known-aborted timer does not prove lease loss. Revalidate authority now,
                    // then let the next ordinary tick capture a new, independently fenced observation.
                    authorityReady = (await acquire()) !== null; lastLease = Date.now();
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
        stopped = true; clearInterval(interval); unsubscribe();
        server.off('upgrade', upgrade);
        for (const connection of connections.values()) connection.socket.terminate();
        connections.clear(); wss.close();
    };
    lifecycle.onDrain(stop);
    server.once('close', stop);
    return { stop, release };
};
