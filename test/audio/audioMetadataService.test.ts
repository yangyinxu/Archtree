import assert from 'node:assert/strict';
import test from 'node:test';

import { embeddedDiscNumber, embeddedTrackNumber } from '../../src/services/audio/audioMetadataService';

test('embedded Track Numbers accept only bounded positive whole numbers', () => {
    assert.equal(embeddedTrackNumber(1), 1);
    assert.equal(embeddedTrackNumber(52), 52);
    assert.equal(embeddedTrackNumber(9_999), 9_999);
    for (const invalid of [undefined, null, '', '1', 0, -1, 1.5, 10_000, Number.NaN]) {
        assert.equal(embeddedTrackNumber(invalid), undefined);
    }
});

test('embedded Disc Numbers accept only bounded positive whole numbers up to 999', () => {
    assert.equal(embeddedDiscNumber(1), 1);
    assert.equal(embeddedDiscNumber(2), 2);
    assert.equal(embeddedDiscNumber(999), 999);
    for (const invalid of [
        undefined, null, '', '1', 0, -1, 1.5, 1_000,
        Number.NaN, Number.POSITIVE_INFINITY, true
    ]) {
        assert.equal(embeddedDiscNumber(invalid), undefined);
    }
});
