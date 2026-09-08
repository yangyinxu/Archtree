export type CoverArtVariantScheduler = <T>(
    clientKey: string,
    abortSignal: AbortSignal | undefined,
    operation: () => Promise<T>
) => Promise<T>;

type PendingCoverArtWork<T> = {
    clientKey: string;
    abortSignal?: AbortSignal;
    operation: () => Promise<T>;
    resolve: (value: T) => void;
    reject: (reason: unknown) => void;
    abortQueued: () => void;
};

export const abortError = () => Object.assign(
    new Error('Cover-art request was aborted.'),
    { name: 'AbortError' }
);

/** Queues bounded derivative work so a normal artwork burst waits instead of returning 429. */
export const createCoverArtVariantScheduler = (
    perClientLimit = 2,
    globalLimit = 4,
    maximumQueued = 128,
    maximumQueuedPerClient = Math.min(32, maximumQueued)
) => {
    if (![perClientLimit, globalLimit, maximumQueued, maximumQueuedPerClient].every(
        (value) => Number.isInteger(value) && value > 0
    ) || perClientLimit > globalLimit || maximumQueuedPerClient > maximumQueued) {
        throw new Error('Cover-art scheduler limits are invalid.');
    }

    let activeGlobal = 0;
    const activeByClient = new Map<string, number>();
    const pendingByClient = new Map<string, PendingCoverArtWork<unknown>[]>();
    const readyClients: string[] = [];
    let pendingCount = 0;

    const removeReadyClient = (clientKey: string) => {
        const index = readyClients.indexOf(clientKey);
        if (index >= 0) readyClients.splice(index, 1);
    };

    const takeNextTask = () => {
        const clientsToCheck = readyClients.length;
        for (let index = 0; index < clientsToCheck; index += 1) {
            const clientKey = readyClients.shift()!;
            const clientQueue = pendingByClient.get(clientKey);
            if (!clientQueue?.length) {
                pendingByClient.delete(clientKey);
                continue;
            }
            if ((activeByClient.get(clientKey) ?? 0) >= perClientLimit) {
                readyClients.push(clientKey);
                continue;
            }

            const task = clientQueue.shift()!;
            pendingCount -= 1;
            if (clientQueue.length > 0) readyClients.push(clientKey);
            else pendingByClient.delete(clientKey);
            return task;
        }
        return undefined;
    };

    const dispatch = () => {
        while (activeGlobal < globalLimit) {
            const task = takeNextTask();
            if (!task) return;
            task.abortSignal?.removeEventListener('abort', task.abortQueued);
            if (task.abortSignal?.aborted) {
                task.reject(abortError());
                continue;
            }

            activeGlobal += 1;
            activeByClient.set(task.clientKey, (activeByClient.get(task.clientKey) ?? 0) + 1);
            Promise.resolve()
                .then(task.operation)
                .then(task.resolve, task.reject)
                .finally(() => {
                    activeGlobal -= 1;
                    const clientActive = (activeByClient.get(task.clientKey) ?? 1) - 1;
                    if (clientActive <= 0) activeByClient.delete(task.clientKey);
                    else activeByClient.set(task.clientKey, clientActive);
                    dispatch();
                });
        }
    };

    const schedule = <T>(clientKey: string, abortSignal: AbortSignal | undefined, operation: () => Promise<T>) => {
        if (abortSignal?.aborted) return Promise.reject(abortError());
        const normalizedClientKey = String(clientKey || 'unknown').slice(0, 128);
        const canStartImmediately = activeGlobal < globalLimit
            && (activeByClient.get(normalizedClientKey) ?? 0) < perClientLimit;
        const queuedForClient = pendingByClient.get(normalizedClientKey)?.length ?? 0;
        if (!canStartImmediately && (
            pendingCount >= maximumQueued
            || queuedForClient >= maximumQueuedPerClient
        )) {
            return Promise.reject(Object.assign(
                new Error('Cover-art derivative queue is full.'),
                { statusCode: 503 }
            ));
        }

        return new Promise<T>((resolve, reject) => {
            const task: PendingCoverArtWork<T> = {
                clientKey: normalizedClientKey,
                abortSignal,
                operation,
                resolve,
                reject,
                abortQueued: () => {
                    const clientQueue = pendingByClient.get(normalizedClientKey);
                    const index = clientQueue?.indexOf(task as PendingCoverArtWork<unknown>) ?? -1;
                    if (index < 0) return;
                    clientQueue!.splice(index, 1);
                    pendingCount -= 1;
                    if (clientQueue!.length === 0) {
                        pendingByClient.delete(normalizedClientKey);
                        removeReadyClient(normalizedClientKey);
                    }
                    abortSignal?.removeEventListener('abort', task.abortQueued);
                    reject(abortError());
                }
            };
            const clientQueue = pendingByClient.get(normalizedClientKey);
            if (clientQueue) clientQueue.push(task as PendingCoverArtWork<unknown>);
            else {
                pendingByClient.set(normalizedClientKey, [task as PendingCoverArtWork<unknown>]);
                readyClients.push(normalizedClientKey);
            }
            pendingCount += 1;
            abortSignal?.addEventListener('abort', task.abortQueued, { once: true });
            dispatch();
        });
    };
    return Object.assign(schedule, {
        snapshot: () => ({ scope: 'process' as const, active: activeGlobal, queued: pendingCount,
            globalLimit, perClientLimit, maximumQueued, maximumQueuedPerClient })
    });
};

/** Low-memory deployments can reduce native image work without changing queue semantics. */
export const createConfiguredCoverArtVariantScheduler = (configuredLimit?: string) => {
    const value = configuredLimit?.trim() || '4';
    if (!/^[1-4]$/.test(value)) {
        throw new Error('COVER_ART_MAX_TRANSFORMS must be an integer from 1 to 4.');
    }
    const globalLimit = Number(value);
    return createCoverArtVariantScheduler(Math.min(2, globalLimit), globalLimit);
};

let configuredScheduler: ReturnType<typeof createConfiguredCoverArtVariantScheduler> | undefined;
/** Resolves configuration after startup has loaded the environment. */
const getConfiguredScheduler = () => configuredScheduler ??= createConfiguredCoverArtVariantScheduler(
    process.env.COVER_ART_MAX_TRANSFORMS
);
export const scheduleCoverArtVariant: CoverArtVariantScheduler = (clientKey, signal, operation) =>
    getConfiguredScheduler()(clientKey, signal, operation);
/** Exposes aggregate occupancy only; client scheduling keys never leave this module. */
export const getCoverArtSchedulingSnapshot = () => getConfiguredScheduler().snapshot();
