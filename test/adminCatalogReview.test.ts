import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { catalogReviewOriginalFilename, parseCatalogReviewFields } from '../src/administration/adminCatalogReviewService';
import { validateAnalysisSuggestions, type AnalysisInput } from '../src/administration/adminImportProvider';

test('review naming evidence accepts only actual bounded basenames and preserves missing evidence', () => {
    for (const input of [undefined, null, '', '/private/music/song.mp3', 'C:\\music\\song.mp3', '../song.mp3', '\ud800', 'Song\u0000.mp3', 'x'.repeat(256)]) assert.equal(catalogReviewOriginalFilename(input), null);
    assert.equal(catalogReviewOriginalFilename(' 01 标题.mp3 '), '01 标题.mp3');
});
test('apply selection cannot mutate Artist identity, Credits, visibility, files or another scope', () => {
    const slotId = randomUUID();
    assert.deepEqual(parseCatalogReviewFields([{ scope: 'track', slotId, field: 'trackNumber' }]), [{ scope: 'track', slotId, field: 'trackNumber' }]);
    for (const field of ['artistName', 'credits', 'visibility', 's3Key', 'albumId']) assert.throws(() => parseCatalogReviewFields([{ scope: 'album', slotId: null, field }]));
    for (const input of [[], [{ scope: 'artist', slotId: null, field: 'title' }], [{ scope: 'track', slotId, field: 'releaseDate' }], [{ scope: 'album', slotId, field: 'title' }], [{ scope: 'album', slotId: null, field: 'title', value: 'Not saved' }]]) assert.throws(() => parseCatalogReviewFields(input));
    const repeated = { scope: 'album', slotId: null, field: 'title' }; assert.throws(() => parseCatalogReviewFields([repeated, repeated]));
});
test('catalog analysis cannot claim nonexistent folder or missing filename evidence', () => {
    const slotId = randomUUID();
    const input: AnalysisInput = { purpose: 'catalogReview', generation: 1, chunk: 0, album: true, slots: [], manifest: { rootLabel: '', files: [{ slotId, filename: '', relativePath: '', byteLength: null }] }, baseline: { album: { title: 'Existing title', artistName: '', releaseDate: null, visibility: 'public' }, tracks: [] } };
    const suggestion = { scope: 'album', slotId: null, field: 'title', text: 'Correction', number: null, date: null, source: 'context', evidence: 'Existing title context' };
    assert.equal(validateAnalysisSuggestions({ suggestions: [suggestion] }, input)[0].source, 'context');
    for (const source of ['filename', 'folder']) assert.throws(() => validateAnalysisSuggestions({ suggestions: [{ ...suggestion, source }] }, input));
    input.manifest.files[0].filename = '01 - Real.mp3';
    assert.equal(validateAnalysisSuggestions({ suggestions: [{ ...suggestion, source: 'filename' }] }, input)[0].source, 'filename');
    const trackInput: AnalysisInput = { ...input, album: false, slots: [slotId], baseline: { ...input.baseline, tracks: [{ slotId, title: 'Existing', trackNumber: null }] } };
    const trackNumber = { ...suggestion, scope: 'track', slotId, field: 'trackNumber', text: null, number: 3 };
    assert.throws(() => validateAnalysisSuggestions({ suggestions: [trackNumber] }, trackInput));
    assert.equal(validateAnalysisSuggestions({ suggestions: [{ ...trackNumber, source: 'filename' }] }, trackInput)[0].value, 3);
    trackInput.manifest.files[0].filename = '';
    assert.throws(() => validateAnalysisSuggestions({ suggestions: [{ ...trackNumber, source: 'filename' }] }, trackInput));
});
