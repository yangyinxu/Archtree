import express from 'express';
import type { IncomingMessage } from 'node:http';
import { configuredTrustProxyHops } from '../config/trustProxy';

/** Reuses Express's audited forwarded-address/protocol resolution without mutating the upgrade request. */
export const createRoomUpgradeContext = () => {
    const application = express();
    application.set('trust proxy', configuredTrustProxyHops());
    return (incoming: IncomingMessage): { ip: string; secure: boolean } => {
        const request = Object.create(express.request) as express.Request;
        Object.assign(request, { app: application, headers: incoming.headers, socket: incoming.socket });
        return { ip: request.ip ?? incoming.socket.remoteAddress ?? 'unknown', secure: request.secure };
    };
};

/** Limits both per-address attempts and the number of retained address buckets during a burst. */
export const createRoomUpgradeRateLimit = () => {
    const windows = new Map<string, { start: number; count: number }>();
    let nextSweep = 0;
    return (ip: string, now = Date.now()): boolean => {
        if (now >= nextSweep) {
            for (const [key, value] of windows) if (now - value.start >= 60_000) windows.delete(key);
            nextSweep = now + 1_000;
        }
        let window = windows.get(ip);
        if (!window || now - window.start >= 60_000) {
            if (!window && windows.size >= 1024) return false;
            window = { start: now, count: 0 }; windows.set(ip, window);
        }
        if (window.count >= 60) return false;
        window.count += 1;
        return true;
    };
};
