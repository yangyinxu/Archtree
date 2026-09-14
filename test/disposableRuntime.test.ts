import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { DisposableResources, runDisposableRuntime } from './support/disposableRuntime';

test('disposable cleanup attempts every stage in reverse order and is idempotent after failure', async () => {
    const resources = new DisposableResources();
    const closed: string[] = [];
    await resources.own('database', name => { closed.push(name); });
    await resources.own('storage', name => { closed.push(name); throw new Error('owned cleanup failure'); });
    await resources.own('server', name => { closed.push(name); });
    await assert.rejects(resources.close(), AggregateError);
    await assert.rejects(resources.close(), AggregateError);
    assert.deepEqual(closed, ['server', 'storage', 'database']);
});

test('interrupted startup waits for and disposes a resource that finishes acquiring late', async () => {
    const resources = new DisposableResources();
    let resolve!: (value: string) => void;
    const closed: string[] = [];
    const acquisition = resources.own(new Promise<string>(done => { resolve = done; }), name => { closed.push(name); });
    const rejected = assert.rejects(acquisition, /startup was interrupted/);
    let finished = false;
    const closing = resources.close().then(() => { finished = true; });
    await Promise.resolve();
    assert.equal(finished, false);
    resolve('late database');
    await Promise.all([closing, rejected]);
    assert.deepEqual(closed, ['late database']);
});

test('startup failure closes allocated resources and removes only its signal handlers', async () => {
    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    const before = signals.map(signal => process.listenerCount(signal));
    let closed = false;
    await assert.rejects(runDisposableRuntime(async resources => {
        await resources.own('synthetic directory', () => { closed = true; });
        throw new Error('synthetic seed failure');
    }), /synthetic seed failure/);
    assert.equal(closed, true);
    assert.deepEqual(signals.map(signal => process.listenerCount(signal)), before);
});

test('the real demo process removes its copied-dist allocation when startup fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'archtree-demo-startup-check-'));
    try {
        await assert.rejects(promisify(execFile)(process.execPath, [
            '--import', createRequire(resolve('package.json')).resolve('tsx'), resolve('scripts/demo-social.ts')
        ], {
            cwd: directory, timeout: 15_000,
            env: { ...process.env, NODE_ENV: 'test', TMPDIR: directory }
        }), error => {
            const failure = error as { code?: number; stderr?: string };
            return failure.code === 1 && Boolean(failure.stderr?.includes('The isolated social demonstration could not start.'));
        });
        assert.deepEqual((await readdir(directory)).filter(name => name.startsWith('archtree-social-demo-web-')), []);
    } finally { await rm(directory, { recursive: true, force: true }); }
});
