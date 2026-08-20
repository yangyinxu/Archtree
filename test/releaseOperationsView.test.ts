import assert from 'node:assert/strict';
import test from 'node:test';

import { renderReleaseOperations } from '../src/views/contentManager/releaseOperationsView';

test('empty operations lead administrators back to the guided setup', () => {
    const html = renderReleaseOperations([]);
    assert.match(html, /Start a guided Artist release/);
    assert.match(html, /view=overview#artist-release-setup/);
});

test('operations show step progress and links without promoting raw IDs', () => {
    const html = renderReleaseOperations([{
        operationId: 'operation-id',
        status: 'complete',
        artistId: 'artist/id',
        albumId: 'album-id',
        carouselId: 'carousel-id',
        pageSlug: 'home',
        steps: {
            artist: { status: 'complete' },
            page: { status: 'complete' }
        }
    }]);

    assert.match(html, /Artist ready/);
    assert.match(html, /Page placement saved/);
    assert.match(html, /prefillId=artist%2Fid/);
    assert.match(html, /data-copy-id="operation-id"/);
    assert.doesNotMatch(html, /Retry incomplete steps/);
});

test('only operations needing attention expose retry and escaped errors', () => {
    const html = renderReleaseOperations([{
        operationId: 'retry-id',
        status: 'needsAttention',
        lastError: '<storage failure>',
        steps: { album: { status: 'failed', error: '<failed>' } }
    }]);

    assert.match(html, /Needs attention/);
    assert.match(html, /Retry incomplete steps/);
    assert.match(html, /&lt;storage failure&gt;/);
    assert.match(html, /&lt;failed&gt;/);
    assert.doesNotMatch(html, /<storage failure>/);
});
