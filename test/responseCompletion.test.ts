import assert from 'node:assert/strict';
import test from 'node:test';
import { ServerResponse, IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { onResponseComplete } from '../src/infrastructure/responseCompletion';

for (const event of ['finish', 'close'] as const) {
  test(`response completion shares hooks and releases each observer once on ${event}`, () => {
    const res = new ServerResponse(new IncomingMessage(new Socket()));
    let calls = 0;
    for (let i = 0; i < 20; i += 1) onResponseComplete(res, () => { calls += 1; });
    assert.equal(res.listenerCount('close'), 1);
    res.emit(event);
    res.emit(event === 'finish' ? 'close' : 'finish');
    assert.equal(calls, 20);
    assert.equal(res.listenerCount('close'), 0);
    onResponseComplete(res, () => { calls += 1; });
    assert.equal(calls, 21);
  });
}

test('already destroyed responses notify without retaining listeners', () => {
  const res = new ServerResponse(new IncomingMessage(new Socket()));
  res.destroy();
  let calls = 0;
  onResponseComplete(res, () => { calls += 1; });
  assert.equal(calls, 1);
  assert.equal(res.listenerCount('close'), 0);
});
