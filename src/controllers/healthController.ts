import { Request, Response } from 'express';
import { Db } from 'mongodb';
import { getDb } from '../infrastructure/database';
import { getMediaDeliveryMetrics } from '../services/mediaDeliveryService';

export interface HealthControllerDependencies {
    getDatabase?: () => Pick<Db, 'command'> | null;
    getMetrics?: typeof getMediaDeliveryMetrics;
    getMemoryUsage?: typeof process.memoryUsage;
    getUptimeSeconds?: typeof process.uptime;
}

/** Creates a bounded readiness handler whose media snapshot contains no request identity. */
export const createHealthController = (
    dependencies: HealthControllerDependencies = {}
) => {
    const getDatabase = dependencies.getDatabase ?? getDb;
    const getMetrics = dependencies.getMetrics ?? getMediaDeliveryMetrics;
    const getMemoryUsage = dependencies.getMemoryUsage ?? process.memoryUsage;
    const getUptimeSeconds = dependencies.getUptimeSeconds ?? process.uptime;

    return async (_req: Request, res: Response) => {
        res.setHeader('Cache-Control', 'no-store');
        try {
            const db = getDatabase();
            if (!db) throw new Error('Database is unavailable.');
            await db.command({ ping: 1 }, { maxTimeMS: 1_000 });
            const memory = getMemoryUsage();
            return res.status(200).json({
                status: 'ok',
                uptimeSeconds: Math.max(0, Math.floor(getUptimeSeconds())),
                mediaDelivery: getMetrics(),
                memory: {
                    rssBytes: memory.rss,
                    heapUsedBytes: memory.heapUsed
                }
            });
        } catch {
            return res.status(503).json({
                status: 'unavailable',
                uptimeSeconds: Math.max(0, Math.floor(getUptimeSeconds())),
                mediaDelivery: getMetrics()
            });
        }
    };
};

export const getHealth = createHealthController();
