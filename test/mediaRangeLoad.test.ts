import assert from 'node:assert/strict';
import test from 'node:test';
import {
    ARTWORK_VARIANT_WIDTHS,
    buildArtworkWorkload,
    buildArtworkVariantPath,
    validateArtworkContract
} from '../scripts/media-range-load.mjs';

test('artwork workload cycles through every supported display width', () => {
    const workload = buildArtworkWorkload(['0123456789abcdef01234567'], 4);
    const paths = workload.map((artworkId, index) => buildArtworkVariantPath(
        artworkId,
        index
    ));

    assert.equal(workload.length, ARTWORK_VARIANT_WIDTHS.length);
    assert.deepEqual(paths, ARTWORK_VARIANT_WIDTHS.map(
        (width) => `/content/images/0123456789abcdef01234567/v1/${width}.webp`
    ));
    assert.equal(
        buildArtworkVariantPath('0123456789abcdef01234567', ARTWORK_VARIANT_WIDTHS.length),
        '/content/images/0123456789abcdef01234567/v1/96.webp'
    );
});

test('artwork response contract requires versioned revalidated WebP metadata', () => {
    const validHeaders = new Headers({
        'cache-control': 'public, no-cache',
        'content-length': '314',
        'content-type': 'image/webp',
        etag: '"cover-art-v1"'
    });

    assert.deepEqual(validateArtworkContract(200, validHeaders), []);
    assert.deepEqual(validateArtworkContract(429, new Headers()), [
        'ARTWORK_THROTTLED',
        'ARTWORK_RETRY_AFTER'
    ]);

    const invalidHeaders = new Headers({
        'cache-control': 'private, max-age=60',
        'content-length': '0',
        'content-type': 'image/jpeg'
    });
    assert.deepEqual(validateArtworkContract(200, invalidHeaders), [
        'ARTWORK_ETAG',
        'ARTWORK_CONTENT_LENGTH',
        'ARTWORK_CONTENT_TYPE',
        'ARTWORK_CACHE_PUBLIC',
        'ARTWORK_CACHE_REVALIDATION'
    ]);
});
