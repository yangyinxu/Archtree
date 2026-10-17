import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const qs = require('qs');

/** Keeps the dependency override tied to its reviewed security boundaries. */
test('query parser enforces comma-array limits for bracket keys', () => {
  assert.throws(() => qs.parse('items[]=1,2,3,4', {
    comma: true, arrayLimit: 3, throwOnLimitExceeded: true
  }), RangeError);
  assert.deepEqual(qs.parse('items[]=1&items[]=2'), { items: ['1', '2'] });
});

test('query round-trips do not invoke attacker-controlled constructor properties', () => {
  const parsed = qs.parse('item[constructor][isBuffer]=malformed', { plainObjects: true });
  assert.doesNotThrow(() => qs.stringify(parsed));
});
