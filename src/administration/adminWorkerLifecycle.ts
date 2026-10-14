/** Timers stop admission immediately; tracked bounded I/O participates in application shutdown. */
export type AdminWorkTracker = (operation: () => Promise<unknown>) => Promise<unknown>;
export const checkAdminWorker = (signal?: AbortSignal) => { if (signal?.aborted) throw new Error('Admin worker stopping'); };
export const adminWorkerSignal = (timeout: AbortSignal, external?: AbortSignal) => external ? AbortSignal.any([timeout, external]) : timeout;
export function startAdminWorker(work: (signal: AbortSignal) => Promise<unknown>, intervalMs: number, track: AdminWorkTracker = operation => operation()) {
    const controller = new AbortController(); let inFlight: Promise<unknown> | undefined;
    const tick = () => { if (controller.signal.aborted || inFlight) return; inFlight = track(() => work(controller.signal)).catch(() => undefined).finally(() => { inFlight = undefined; }); };
    const timer = setInterval(tick, intervalMs); timer.unref(); tick();
    return async () => { controller.abort(); clearInterval(timer); await inFlight; };
}
