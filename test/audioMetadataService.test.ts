import assert from 'node:assert/strict';
import test from 'node:test';

import { embeddedTrackNumber } from '../src/services/audioMetadataService';

test('embedded Track Numbers accept only bounded positive whole numbers', () => {
    assert.equal(embeddedTrackNumber(1), 1);
    assert.equal(embeddedTrackNumber(52), 52);
    assert.equal(embeddedTrackNumber(9_999), 9_999);
    for (const invalid of [undefined, null, '', '1', 0, -1, 1.5, 10_000, Number.NaN]) {
        assert.equal(embeddedTrackNumber(invalid), undefined);
    }
});
