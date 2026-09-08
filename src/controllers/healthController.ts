import { Request, Response } from 'express';
import { Db } from 'mongodb';
import { checkDatabaseReadiness, getDb } from '../infrastructure/database';
import { getMediaDeliveryMetrics } from '../services/mediaDeliveryService';
import type { createRequestDiagnostics } from '../middleware/requestDiagnosticsMiddleware';
import { getRuntimeResources } from '../services/runtimeResourcesService';
import { createReadinessProbe } from '../infrastructure/readinessProbe';

/** Slow optional capacity diagnostics must not hold an otherwise ready response. */
const withinDeadline = <T>(operation: Promise<T>, fallback: T, milliseconds: number): Promise<T> =>
    new Promise(resolve => {
        const timer = setTimeout(() => resolve(fallback), milliseconds);
        operation.then(resolve, () => resolve(fallback)).finally(() => clearTimeout(timer));
    });

export interface HealthControllerDependencies {
    isDraining?: () => boolean;
    /** Includes transaction topology and required indexes; never starts a transaction. */
    checkIndexes?: () => Promise<boolean>;
    getRequestMetrics?: ReturnType<typeof createRequestDiagnostics>['snapshot'];
    getResources?: typeof getRuntimeResources;
    getDatabase?: () => Pick<Db, 'command'> | null;
    getMetrics?: typeof getMediaDeliveryMetrics;
    getMemoryUsage?: typeof process.memoryUsage;
    getUptimeSeconds?: typeof process.uptime;
    now?: () => number;
}

/** Creates a bounded readiness handler whose media snapshot contains no request identity. */
export const createHealthController = (
    dependencies: HealthControllerDependencies = {}
) => {
    const getDatabase = dependencies.getDatabase ?? getDb;
    const getMetrics = dependencies.getMetrics ?? getMediaDeliveryMetrics;
    const getMemoryUsage = dependencies.getMemoryUsage ?? process.memoryUsage;
    const getUptimeSeconds = dependencies.getUptimeSeconds ?? process.uptime;
    const checkIndexes = dependencies.checkIndexes ?? checkDatabaseReadiness;
    const probeDatabase = createReadinessProbe<Pick<Db, 'command'>>(async (db, signal) => {
        if (!await checkIndexes() || signal.aborted || getDatabase() !== db) return false;
        await db.command({ ping: 1 }, { maxTimeMS: 1_000 });
        return !signal.aborted && getDatabase() === db;
    }, { now: dependencies.now });

    return async (_req: Request, res: Response) => {
        res.setHeader('Cache-Control', 'no-store');
        try {
            if (dependencies.isDraining?.()) throw new Error('Service is draining.');
            const db = getDatabase();
            if (!db) throw new Error('Database is unavailable.');
            if (!await probeDatabase(db)) throw new Error('Database readiness probe did not complete.');
            const resources = await withinDeadline<Awaited<ReturnType<typeof getRuntimeResources>> | null>(
                (dependencies.getResources ?? getRuntimeResources)(), null, 250
            );
            if (dependencies.isDraining?.()) throw new Error('Service began draining during readiness check.');
            if (getDatabase() !== db) throw new Error('Database changed during readiness check.');
            const memory = getMemoryUsage();
            return res.status(200).json({
                status: 'ok',
                uptimeSeconds: Math.max(0, Math.floor(getUptimeSeconds())),
                mediaDelivery: getMetrics(),
                requests: dependencies.getRequestMetrics?.(),
                resources,
                memory: {
                    rssBytes: memory.rss,
                    heapUsedBytes: memory.heapUsed
                }
            });
        } catch {
            return res.status(503).json({
                status: 'unavailable',
                uptimeSeconds: Math.max(0, Math.floor(getUptimeSeconds())),
                mediaDelivery: getMetrics(),
                requests: dependencies.getRequestMetrics?.()
            });
        }
    };
};

export const getHealth = createHealthController();
