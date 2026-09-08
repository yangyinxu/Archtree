import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createReadinessProbe } from '../src/infrastructure/readinessProbe';

test('timed-out callers share one occupied slot until the underlying operation settles', async () => {
  let calls = 0;
  let release!: (ready: boolean) => void;
  let signal!: AbortSignal;
  const probe = createReadinessProbe<string>((_key, currentSignal) => {
    calls++;
    signal = currentSignal;
    return new Promise(resolve => { release = resolve; });
  }, { deadlineMs: 15, cacheMs: 0 });
  const first = probe('first');
  assert.equal(probe('first'), first);
  assert.equal(await first, false);
  assert.equal(signal.aborted, true);
  for (let batch = 0; batch < 3; batch++) {
    assert.deepEqual(await Promise.all(Array.from({ length: 25 }, () => probe('first'))), Array(25).fill(false));
    assert.equal(await probe(`replacement-${batch}`), false);
  }
  assert.equal(calls, 1);
  release(true);
  await delay(0);
  const retry = probe('replacement');
  await delay(0);
  assert.equal(calls, 2);
  release(true);
  assert.equal(await retry, true);
});

test('successful and failed probes have a short cache and do not reuse another identity', async () => {
  let now = 0;
  let ready = false;
  let calls = 0;
  const probe = createReadinessProbe(async () => { calls++; return ready; }, { now: () => now });
  assert.equal(await probe('first'), false);
  ready = true;
  assert.equal(await probe('first'), false);
  assert.equal(calls, 1);
  now = 1_001;
  assert.equal(await probe('first'), true);
  assert.equal(await probe('first'), true);
  assert.equal(calls, 2);
  assert.equal(await probe('second'), true);
  assert.equal(calls, 3);
});

test('synchronous throws and rejections release admission without leaking their error', async () => {
  for (const failure of [() => { throw new Error('private detail'); }, () => Promise.reject(new Error('private detail'))]) {
    let calls = 0;
    const probe = createReadinessProbe(() => { calls++; return failure(); }, { cacheMs: 0 });
    assert.equal(await probe('database'), false);
    assert.equal(await probe('database'), false);
    assert.equal(calls, 2);
  }
});
