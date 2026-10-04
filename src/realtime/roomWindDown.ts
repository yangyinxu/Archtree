import type { Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { createRoomService } from '../application/rooms/roomService';
import type { RoomApi } from '../contracts/roomV1';
import { SocialError } from '../contracts/socialV1';
import { getDb } from '../infrastructure/database';
import type { ServerLifecycle } from '../services/serverLifecycleService';
import { roomAuthority } from './roomAuthority';
import { roomGatewayMetrics, type RoomGatewayMetrics } from './roomGatewayMetrics';

/**
 * Disabled rooms only need coarse timers: the 30-second host grace, the five-minute host close and the
 * 24-hour expiry. A slow cadence keeps a switched-off release cheap on a small instance and database,
 * while staying well inside the 10-second authority lease that every tick renews.
 */
export const ROOM_WIND_DOWN_INTERVAL_MS = 5_000;

export interface RoomWindDownOptions {
    api?: Pick<RoomApi, 'sweep'>;
    hasOpenRooms?: () => Promise<boolean>;
    acquire?: () => Promise<number | null>;
    release?: () => Promise<void>;
    metrics?: RoomGatewayMetrics;
    intervalMs?: number;
    log?: (entry: { category: 'room_wind_down'; state: 'started' | 'complete' }) => void;
}

/** The shared fixed-shape rejection a disabled gateway sends; it never reaches Express or ticket redemption. */
const refuseUpgrade = (_req: unknown, socket: Duplex) => {
    socket.on('error', () => socket.destroy());
    if (!socket.destroyed) socket.end('HTTP/1.1 503 Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
};

const openRoomExists = async () => {
    const db = getDb();
    if (!db) throw new SocialError(503, 'room_unavailable');
    return Boolean(await db.collection('socialRooms').findOne({ state: 'open' }, { projection: { _id: 1 } }));
};

/**
 * Runs instead of the realtime gateway when a process starts with rooms switched off. Rooms left open by an
 * earlier process must not silently persist: this refuses every realtime upgrade and, while any room is
 * open, holds the room authority to run the ordinary sweep with rooms disabled. That sweep pauses shared
 * playback and ends rooms through the existing host-absence and 24-hour rules; no new timer exists. With no
 * room left open it releases the authority and goes idle, since a disabled release cannot open another.
 */
export const installRoomWindDown = (server: Server, lifecycle: ServerLifecycle, options: RoomWindDownOptions = {}) => {
    // This process booted disabled, so its sweep never treats rooms as enabled, whatever the environment says later.
    const api = options.api ?? createRoomService({ enabled: () => false });
    const hasOpenRooms = options.hasOpenRooms ?? openRoomExists;
    const acquire = options.acquire ?? (() => roomAuthority.acquire());
    const release = options.release ?? (() => roomAuthority.release());
    const metrics = options.metrics ?? roomGatewayMetrics;
    const log = options.log ?? (entry => { console.log(JSON.stringify(entry)); });
    let stopped = false;
    let ticking = false;
    let complete = false;
    let started = false;
    server.on('upgrade', refuseUpgrade);
    metrics.setAuthorityState('starting');

    const finish = async () => {
        complete = true;
        clearInterval(interval);
        // A lost release is harmless: the conditional lease expires by itself within 10 seconds.
        try { await release(); } catch { /* keep the completed state */ }
        if (!stopped) metrics.setAuthorityState('inactive');
        log({ category: 'room_wind_down', state: 'complete' });
    };

    /** Each failure is retried by the next tick with a freshly acquired lease, never by replaying a write. */
    const tick = async () => {
        if (stopped || ticking || complete) return;
        ticking = true;
        let stage: 'sweep' | 'authorityAcquisition' = 'sweep';
        try {
            await lifecycle.track(async () => {
                if (!await hasOpenRooms()) { await finish(); return; }
                if (!started) { started = true; log({ category: 'room_wind_down', state: 'started' }); }
                stage = 'authorityAcquisition';
                if (await acquire() === null) {
                    metrics.recordFailure('authorityAcquisition');
                    if (!stopped) metrics.setAuthorityState('unavailable');
                    return;
                }
                stage = 'sweep';
                if (stopped) return;
                metrics.setAuthorityState('windingDown');
                await api.sweep();
                metrics.recordSuccessfulSweep();
                if (!await hasOpenRooms()) await finish();
            });
        } catch {
            if (!stopped) { metrics.recordFailure(stage); metrics.setAuthorityState('unavailable'); }
        } finally { ticking = false; }
    };
    const interval = setInterval(() => { void tick(); }, options.intervalMs ?? ROOM_WIND_DOWN_INTERVAL_MS);
    interval.unref();
    void tick();

    /** Shutdown keeps refusing upgrades until the server closes; only this process's matching lease is released. */
    const stop = () => {
        if (stopped) return;
        stopped = true; clearInterval(interval);
        metrics.setAuthorityState('stopped');
    };
    lifecycle.onDrain(stop);
    server.once('close', stop);
    return { stop, release };
};
