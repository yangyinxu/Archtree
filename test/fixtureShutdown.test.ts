import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { startFixtureShutdown } from '../web/e2e-social/support/fixtureShutdown';

test('disposable shutdown requires its ephemeral capability and confirms cleanup only after completion', async () => {
  const token = randomUUID();
  let release!: () => void;
  let calls = 0;
  const control = await startFixtureShutdown(0, token, () => {
    calls++;
    control.stopAccepting();
    return new Promise<void>(resolve => { release = resolve; });
  });
  const url = `http://127.0.0.1:${control.port}/stop`;
  try {
    for (const init of [{ method: 'GET', headers: { 'x-fixture-stop-token': token } },
      { method: 'POST', headers: { 'x-fixture-stop-token': randomUUID() } }]) {
      assert.equal((await fetch(url, init)).status, 404);
    }
    assert.equal(calls, 0);
    let complete = false;
    const stopped = fetch(url, { method: 'POST', headers: { 'x-fixture-stop-token': token } }).then(async response => {
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { cleanupComplete: true });
      complete = true;
    });
    while (!calls) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(complete, false);
    release();
    await stopped;
    assert.equal(calls, 1);
    await assert.rejects(fetch(url));
  } finally { release?.(); control.stopAccepting(); }
});

test('invalid shutdown capabilities cannot allocate a listener', async () => {
  await assert.rejects(startFixtureShutdown(0, 'invalid', async () => {}), /Invalid disposable shutdown capability/);
});

test('cleanup failure returns only a fixed result and leaves a failing fixture exit status', async () => {
  const token = randomUUID();
  const previous = process.exitCode;
  const control = await startFixtureShutdown(0, token, async () => { throw new Error('private fixture payload'); });
  try {
    const response = await fetch(`http://127.0.0.1:${control.port}/stop`, {
      method: 'POST', headers: { 'x-fixture-stop-token': token }
    });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { cleanupComplete: false });
    assert.equal(process.exitCode, 1);
  } finally { process.exitCode = previous; control.stopAccepting(); }
});
