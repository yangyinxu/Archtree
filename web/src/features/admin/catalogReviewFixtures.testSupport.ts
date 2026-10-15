import type { CatalogItem } from './catalogApi';
import type { CatalogReview } from './catalogReviewApi';
import { slotId, slotTwo, viewer } from './adminFixtures.testSupport';

export { deferred, session, slotId, slotTwo, viewer } from './adminFixtures.testSupport';
export const reviewId = '999999999999999999999999';
export const otherReviewId = 'eeeeeeeeeeeeeeeeeeeeeeee';
export const albumId = '111111111111111111111111';
export const albumRevision = `cr_${'a'.repeat(43)}`;
export const titleSuggestionId = 'cccccccccccccccccccccccc';
export const trackSuggestionId = 'dddddddddddddddddddddddd';

/** Every identity and name is fabricated; evidence distinguishes actual names from historical absence. */
export function catalogReview(): CatalogReview {
  return {
    id: reviewId, revision: 1, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', startedByMe: true,
    state: 'reviewing', sourceStatus: 'current',
    source: {
      album: { id: albumId, revision: albumRevision, title: 'Synthetic catalog Album', releaseDate: null, visibility: 'public' },
      tracks: [
        { slotId, id: '333333333333333333333333', revision: albumRevision, title: 'Synthetic first track', trackNumber: 1, originalFileName: '01 Synthetic.mp3' },
        { slotId: slotTwo, id: '444444444444444444444444', revision: albumRevision, title: 'Synthetic second track', trackNumber: null, originalFileName: null }
      ]
    },
    draft: {
      album: { title: 'Synthetic catalog Album', artistName: 'Synthetic catalog Artist', releaseDate: null, visibility: 'public' },
      tracks: [{ slotId, title: 'Synthetic first track', trackNumber: 1 }, { slotId: slotTwo, title: 'Synthetic second track', trackNumber: null }]
    },
    analysis: { state: 'complete', generation: 1, operationId: '20000000-0000-4000-8000-000000000001', completedChunks: 2, totalChunks: 2, attemptsUsed: 2, maxAttempts: 22, issue: null },
    suggestions: [
      { id: titleSuggestionId, generation: 1, scope: 'album', slotId: null, field: 'title', baseline: 'Synthetic catalog Album', value: 'Reviewed synthetic Album', source: 'context', evidence: 'Saved synthetic title', decision: 'pending' },
      { id: trackSuggestionId, generation: 1, scope: 'track', slotId, field: 'title', baseline: 'Synthetic first track', value: 'Reviewed synthetic first track', source: 'filename', evidence: '01 Synthetic.mp3', decision: 'pending' }
    ],
    capabilities: { analysis: true, apply: true }, applied: null, receipts: []
  };
}

export const catalogAlbum = (): Extract<CatalogItem, { kind: 'album' }> => ({
  kind: 'album', id: albumId, revision: albumRevision, visibility: 'public', effectiveVisibility: 'public',
  coverUrl: null, mediaUrl: null, capabilities: { editing: true, visibility: true },
  fields: { title: 'Synthetic catalog Album', releaseDate: null, credits: null, attributionStatus: 'unknown' }
});

export const reviewJson = (value: unknown, status = 200, account = viewer) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json', 'X-Finitude-Account-Viewer': account }
});
