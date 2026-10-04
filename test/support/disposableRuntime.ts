/** Owns disposable fixture resources, including acquisitions that finish after interruption. */
export class DisposableResources {
    private cleanups: Array<() => void | Promise<void>> = [];
    private acquiring = new Set<Promise<unknown>>();
    private acquisitionCleanupFailures: unknown[] = [];
    private closing?: Promise<void>;

    own<T>(acquiring: T | Promise<T>, dispose: (resource: T) => void | Promise<void>): Promise<T> {
        const acquisition = Promise.resolve(acquiring).then(async resource => {
            if (this.closing) {
                try { await dispose(resource); } catch (error) { this.acquisitionCleanupFailures.push(error); throw error; }
                throw new Error('Disposable startup was interrupted.');
            }
            this.cleanups.push(() => dispose(resource));
            return resource;
        });
        this.acquiring.add(acquisition);
        void acquisition.then(() => this.acquiring.delete(acquisition), () => this.acquiring.delete(acquisition));
        return acquisition;
    }

    /** Attempt every cleanup in reverse acquisition order even when an earlier one fails. */
    close(): Promise<void> {
        this.closing ??= Promise.resolve().then(async () => {
            while (this.acquiring.size) await Promise.allSettled([...this.acquiring]);
            const failures: unknown[] = this.acquisitionCleanupFailures.splice(0);
            for (const cleanup of this.cleanups.splice(0).reverse()) {
                try { await cleanup(); } catch (error) { failures.push(error); }
            }
            if (failures.length) throw new AggregateError(failures, 'Disposable resource cleanup failed.');
        });
        return this.closing;
    }
}

/** Gives a local fixture one signal owner from its first allocation through server drain. */
export const runDisposableRuntime = async (start: (resources: DisposableResources) => Promise<void>) => {
    const resources = new DisposableResources();
    let interrupted = false;
    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    const close = () => resources.close().finally(() => {
        for (const signal of signals) process.off(signal, interrupt);
    });
    const interrupt = () => {
        interrupted = true;
        // Keep the process alive until owned resources and any pending acquisition finish.
        void close().catch(() => { process.exitCode = 1; });
    };
    for (const signal of signals) process.on(signal, interrupt);
    try {
        await start(resources);
    } catch (error) {
        try { await close(); } catch { process.exitCode = 1; }
        if (!interrupted) throw error;
    }
};
