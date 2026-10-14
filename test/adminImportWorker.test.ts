import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startAdminWorker } from '../src/administration/adminWorkerLifecycle';

test('worker work is tracked; stop aborts current work and prohibits every later timer admission', async () => {
    let resolve!: () => void, calls = 0, tracked = 0, observed: AbortSignal | undefined;
    const held = new Promise<void>(done => { resolve = done; });
    const stop = startAdminWorker(async signal => { calls++; observed = signal; await held; }, 2, async work => { tracked++; return work(); });
    const stopped = stop(); assert.equal(observed?.aborted, true); resolve(); await stopped;
    await new Promise(done => setTimeout(done, 10)); assert.equal(calls, 1); assert.equal(tracked, 1);
});
