import assert from 'node:assert/strict';
import test from 'node:test';

import { boundedLimit, boundedOffset } from '../src/utils/pagination';

test('public pagination accepts only bounded finite integers', () => {
    assert.equal(boundedLimit(undefined, 50, 100), 50);
    assert.equal(boundedLimit('Infinity', 50, 100), 50);
    assert.equal(boundedLimit('1.9', 50, 100), 1);
    assert.equal(boundedLimit('-2', 50, 100), 1);
    assert.equal(boundedLimit('500', 50, 100), 100);

    assert.equal(boundedOffset(undefined), 0);
    assert.equal(boundedOffset('Infinity'), 0);
    assert.equal(boundedOffset('4.9'), 4);
    assert.equal(boundedOffset('-2'), 0);
    assert.equal(boundedOffset('999999999'), 1_000_000);
});
