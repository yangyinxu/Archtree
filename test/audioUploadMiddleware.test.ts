import assert from 'node:assert/strict';
import test from 'node:test';

import { maxAudioBatchFiles } from '../src/middleware/audioUpload';

test('bulk Audio selections accept exactly the 100-file administrator contract', () => {
    assert.equal(maxAudioBatchFiles, 100);
});
