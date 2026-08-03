import assert from 'node:assert/strict';
import test from 'node:test';

import { createCoverArtVariantScheduler } from '../src/services/imageStorageService';

const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise; });
    return { promise, resolve };
};

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test('artwork derivative work queues bursts under per-client and global bounds', async () => {
    const schedule = createCoverArtVariantScheduler(1, 2, 8);
    const firstGate = deferred();
    const secondGate = deferred();
    const started: string[] = [];

    const first = schedule('client-a', undefined, async () => {
        started.push('a-1');
        await firstGate.promise;
        return 'a-1';
    });
    const queued = schedule('client-a', undefined, async () => {
        started.push('a-2');
        return 'a-2';
    });
    const second = schedule('client-b', undefined, async () => {
        started.push('b-1');
        await secondGate.promise;
        return 'b-1';
    });

    await nextTurn();
    assert.deepEqual(started, ['a-1', 'b-1']);
    firstGate.resolve();
    assert.equal(await first, 'a-1');
    assert.equal(await queued, 'a-2');
    secondGate.resolve();
    assert.equal(await second, 'b-1');
});

test('aborting active Sharp work does not release its scheduler slot early', async () => {
    const schedule = createCoverArtVariantScheduler(1, 1, 4);
    const activeGate = deferred();
    const controller = new AbortController();
    let queuedStarted = false;

    const active = schedule('client-a', controller.signal, async () => {
        await activeGate.promise;
        return 'finished';
    });
    await nextTurn();
    controller.abort();
    const queued = schedule('client-a', undefined, async () => {
        queuedStarted = true;
        return 'queued';
    });
    await nextTurn();
    assert.equal(queuedStarted, false);

    activeGate.resolve();
    assert.equal(await active, 'finished');
    assert.equal(await queued, 'queued');
});

test('one client cannot fill the global queue or block an idle worker', async () => {
    const schedule = createCoverArtVariantScheduler(1, 2, 4, 2);
    const firstGate = deferred();
    const otherGate = deferred();
    let otherStarted = false;

    const first = schedule('client-a', undefined, async () => {
        await firstGate.promise;
        return 'first';
    });
    await nextTurn();
    const queued = [
        schedule('client-a', undefined, async () => 'queued-1'),
        schedule('client-a', undefined, async () => 'queued-2')
    ];
    await assert.rejects(
        schedule('client-a', undefined, async () => 'rejected'),
        (error: any) => error?.statusCode === 503
    );

    const other = schedule('client-b', undefined, async () => {
        otherStarted = true;
        await otherGate.promise;
        return 'other';
    });
    await nextTurn();
    assert.equal(otherStarted, true);

    firstGate.resolve();
    otherGate.resolve();
    assert.equal(await first, 'first');
    assert.deepEqual(await Promise.all(queued), ['queued-1', 'queued-2']);
    assert.equal(await other, 'other');
});

test('round-robin dispatch gives a new client bounded progress under full load', async () => {
    const schedule = createCoverArtVariantScheduler(2, 4, 16, 8);
    const activeGates = Array.from({ length: 4 }, deferred);
    const backlogGate = deferred();
    const active = [
        schedule('client-a', undefined, async () => { await activeGates[0].promise; }),
        schedule('client-a', undefined, async () => { await activeGates[1].promise; }),
        schedule('client-b', undefined, async () => { await activeGates[2].promise; }),
        schedule('client-b', undefined, async () => { await activeGates[3].promise; })
    ];
    await nextTurn();
    const backlog = [
        schedule('client-a', undefined, async () => { await backlogGate.promise; }),
        schedule('client-a', undefined, async () => { await backlogGate.promise; }),
        schedule('client-b', undefined, async () => { await backlogGate.promise; }),
        schedule('client-b', undefined, async () => { await backlogGate.promise; })
    ];
    let newcomerStarted = false;
    const newcomer = schedule('client-c', undefined, async () => {
        newcomerStarted = true;
    });

    activeGates[0].resolve();
    await active[0];
    await nextTurn();
    assert.equal(newcomerStarted, false);
    activeGates[2].resolve();
    await active[2];
    await nextTurn();
    assert.equal(newcomerStarted, false);
    activeGates[1].resolve();
    await active[1];
    await nextTurn();
    assert.equal(newcomerStarted, true);

    activeGates[3].resolve();
    backlogGate.resolve();
    await Promise.all([...active, ...backlog, newcomer]);
});
