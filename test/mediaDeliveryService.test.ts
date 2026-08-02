import assert from 'node:assert/strict';
import test from 'node:test';

import {
    attachmentContentDisposition,
    parseSingleByteRange,
    shouldHonorRange
} from '../src/services/mediaDeliveryService';

test('parseSingleByteRange parses bounded, open-ended, and suffix ranges', () => {
    assert.deepEqual(parseSingleByteRange('bytes=10-19', 100, 100), { start: 10, end: 19 });
    assert.deepEqual(parseSingleByteRange('bytes=90-', 100, 100), { start: 90, end: 99 });
    assert.deepEqual(parseSingleByteRange('bytes=-10', 100, 100), { start: 90, end: 99 });
});

test('parseSingleByteRange rejects invalid and multi-part ranges', () => {
    assert.equal(parseSingleByteRange('bytes=100-110', 100, 100), null);
    assert.equal(parseSingleByteRange('bytes=20-10', 100, 100), null);
    assert.equal(parseSingleByteRange('bytes=0-1,5-6', 100, 100), null);
});

test('parseSingleByteRange limits a response to the configured maximum', () => {
    assert.deepEqual(parseSingleByteRange('bytes=10-', 100, 20), { start: 10, end: 29 });
    assert.deepEqual(parseSingleByteRange('bytes=-50', 100, 20), { start: 80, end: 99 });
});

test('shouldHonorRange requires a matching strong validator when If-Range is supplied', () => {
    assert.equal(shouldHonorRange(undefined, undefined), true);
    assert.equal(shouldHonorRange('"current"', '"current"'), true);
    assert.equal(shouldHonorRange('"stale"', '"current"'), false);
    assert.equal(shouldHonorRange('W/"current"', 'W/"current"'), false);
    assert.equal(shouldHonorRange('"current"', undefined), false);
});

test('attachmentContentDisposition preserves Unicode while sanitizing fallback filenames', () => {
    const value = attachmentContentDisposition('創生\r\n../track".flac', 'track-id');

    assert.match(value, /^attachment; filename="[^"]+"; filename\*=UTF-8''/);
    assert.equal(value.includes('\r'), false);
    assert.equal(value.includes('\n'), false);
    assert.equal(value.includes('../'), false);
    assert.match(value, /%E5%89%B5%E7%94%9F/);
});

test('attachmentContentDisposition supplies a stable fallback filename', () => {
    assert.equal(
        attachmentContentDisposition(undefined, 'track-id'),
        'attachment; filename="track-id.mp3"; filename*=UTF-8\'\'track-id.mp3'
    );
});
