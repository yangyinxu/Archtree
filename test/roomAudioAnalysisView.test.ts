import assert from 'node:assert/strict';
import test from 'node:test';
import type { RoomAudioAnalysisItem } from '../src/contracts/roomAudioAnalysis';
import { renderRoomAudioAnalysisPage, roomAudioAnalysisPath } from '../src/views/contentManager/roomAudioAnalysisView';

const item = (status: RoomAudioAnalysisItem['status'], index = 1): RoomAudioAnalysisItem => ({
    mediaTrackId: index.toString(16).padStart(24, '0'), title: `Track ${index}`, status,
    sourceRevision: 'a'.repeat(64), attemptId: 'b'.repeat(32), updatedAt: null, reason: null
});

test('only unanalyzed and recoverable sources expose a source-fenced action', () => {
    const statuses: RoomAudioAnalysisItem['status'][] = ['eligible', 'notAnalyzed', 'running', 'retryable', 'unsupported', 'unavailable'];
    const html = renderRoomAudioAnalysisPage({ items: statuses.map((status, index) => item(status, index + 1)), nextAfter: null });
    assert.equal((html.match(/<form method="POST"/g) ?? []).length, 2);
    assert.match(html, /name="mediaTrackId" value="000000000000000000000002"/);
    assert.match(html, /name="mediaTrackId" value="000000000000000000000004"/);
    assert.match(html, /Analyze audio<\/button>/);
    assert.match(html, /Retry analysis<\/button>/);
    assert.match(html, /name="sourceRevision" value="a{64}"/);
    assert.match(html, /name="attemptId" value="b{32}"/);
    assert.doesNotMatch(html, /<audio|<video|<script|http-equiv="refresh"/);
});

test('analysis status escapes catalog text and never renders private diagnostics', () => {
    const html = renderRoomAudioAnalysisPage({
        items: [{ ...item('retryable'), title: '<img src=x onerror=alert(1)>', reason: 'storage_unavailable', updatedAt: 'invalid', s3Key: 'private-storage-key', decoderError: 'private-error' } as RoomAudioAnalysisItem],
        nextAfter: null
    });
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.match(html, /The stored file could not be read/);
    assert.doesNotMatch(html, /<img|private-storage-key|private-error|datetime=/);
    const malformed = renderRoomAudioAnalysisPage({ items: [{ ...item('retryable'), sourceRevision: 'invalid' }], nextAfter: null });
    assert.doesNotMatch(malformed, /<form/);
});

test('pagination, refresh and retry preserve the current bounded page without a stale success claim', () => {
    const after = 'c'.repeat(24);
    const html = renderRoomAudioAnalysisPage({ items: [item('notAnalyzed')], nextAfter: 'd'.repeat(24) }, { after, notice: 'finished' });
    assert.match(html, new RegExp(`href="${roomAudioAnalysisPath}\\?after=${after}">Refresh status`));
    assert.match(html, new RegExp(`name="after" value="${after}"`));
    assert.match(html, /after=d{24}">Next page/);
    assert.match(html, />First page<\/a>/);
    assert.match(html, /Check the current analysis status below/);
    assert.match(html, /Not analyzed/);
    assert.doesNotMatch(html, /Analysis completed successfully/);
});

test('unknown and interrupted work remains explicit and recoverable', () => {
    const html = renderRoomAudioAnalysisPage({ items: [{ ...item('retryable'), reason: 'interrupted' }], nextAfter: null }, { notice: 'unknown' });
    assert.match(html, /result could not be confirmed/);
    assert.match(html, /previous attempt was interrupted/);
    assert.match(html, /Retry analysis<\/button>/);
    const empty = renderRoomAudioAnalysisPage({ items: [], nextAfter: null });
    assert.match(empty, /No Audio sources on this page/);
    assert.doesNotMatch(empty, /Next page|First page|<form/);
});
