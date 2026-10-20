import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ImportDetail } from './adminApi';
import type { AdminGuard } from './adminTransport';
import { adminWorkspace } from './adminWorkspace';
import type { ImportUploadQueue, UploadQueueSnapshot } from './importUploadQueue';

type UploadEngine = typeof import('./importUploadQueue');
/** Commands issued before the engine has loaded run in their original order once it has; a failed load sends nothing. */
export type UploadQueueCommands = Pick<ImportUploadQueue, 'start' | 'enqueue' | 'discard' | 'observe'> & { reconcileOnOpen(item: ImportDetail, guard: AdminGuard): void };
/** What an import page passes to its media panels: the queue's current state and its commands. */
export type ImportUploadQueueView = UploadQueueSnapshot & { queue: UploadQueueCommands };

let engine: UploadEngine | undefined, loading: Promise<UploadEngine> | undefined;
/** Shares one on-demand load of the queue engine, outside the import pages' initial JavaScript; a failed load can be retried. */
export const loadImportUploadQueue = () => loading ??= import('./importUploadQueue').then(module => engine = module, (error: unknown) => {
  loading = undefined;
  throw error;
});
const idle: UploadQueueSnapshot = { running: false, current: null, stopped: null, files: {}, latest: null };
const idleSnapshot = () => idle, subscribeIdle = () => () => {};

/**
 * Subscribes a component to the retained queue for one import without creating or restarting work. Until the engine
 * first loads, the component shows a new queue's idle state; the queue it then opens belongs to its mount's guard.
 */
export function useImportUploadQueue(importId: string): ImportUploadQueueView {
  const key = `upload-queue:${importId}`;
  const [owner] = useState(() => adminWorkspace.capture());
  const open = (module: UploadEngine) => module.importUploadQueue(importId, owner);
  const [loaded, setLoaded] = useState(() => engine && open(engine));
  const queue = loaded ?? adminWorkspace.buffer<ImportUploadQueue>(key);
  useEffect(() => {
    if (loaded) return;
    let current = true;
    loadImportUploadQueue().then(module => { if (current) setLoaded(open(module)); }, () => { /* The next command retries the load. */ });
    return () => { current = false; };
  }, [loaded]);
  const snapshot = useSyncExternalStore(queue?.subscribe ?? subscribeIdle, queue?.getSnapshot ?? idleSnapshot, queue?.getSnapshot ?? idleSnapshot);
  const run = (command: (queue: ImportUploadQueue) => unknown) => {
    const ready = loaded ?? adminWorkspace.buffer<ImportUploadQueue>(key) ?? (engine && open(engine));
    if (ready) command(ready);
    else loadImportUploadQueue().then(module => { const opened = open(module); setLoaded(opened); command(opened); }, () => { /* Nothing was sent; the control stays available. */ });
  };
  const commands: UploadQueueCommands = {
    start: (...args) => run(queue => queue.start(...args)),
    enqueue: (...args) => run(queue => queue.enqueue(...args)),
    discard: slotId => run(queue => queue.discard(slotId)),
    observe: item => run(queue => queue.observe(item)),
    reconcileOnOpen: (item, guard) => run(queue => queue.reconcileOnOpen(item, guard))
  };
  return { ...snapshot, queue: commands };
}
