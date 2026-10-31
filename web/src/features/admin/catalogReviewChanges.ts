import type { CatalogReview, ReviewField } from './catalogReviewApi';

/**
 * The changes an apply of a review can write, compared with the captured source, apart from the response schemas
 * (catalogReviewApi.ts), so the Update selection's model and the chunks that carry it never load the strict schemas.
 */

export type ReviewChange = ReviewField & { baseline: unknown; value: unknown; title: string };
export const reviewFieldKey = (value: ReviewField) => `${value.scope}:${value.slotId ?? ''}:${value.field}`;

/**
 * Only explicit metadata differences are eligible: Album title and date, then per Track its title, Disc Number (only where the
 * source captured one) and Track Number. Artist entries, label and visibility are read-only context and never become changes.
 */
export function reviewChanges(item: CatalogReview): ReviewChange[] {
  const values: ReviewChange[] = [];
  for (const field of ['title', 'releaseDate'] as const) {
    const baseline = item.source.album[field], value = item.draft.album[field];
    if (JSON.stringify(baseline) !== JSON.stringify(value)) values.push({ scope: 'album', slotId: null, field, baseline, value, title: item.source.album.title });
  }
  for (const track of item.source.tracks) {
    const draft = item.draft.tracks.find(value => value.slotId === track.slotId)!;
    for (const field of ['title', 'discNumber', 'trackNumber'] as const) {
      if (field === 'discNumber' && track.discNumber === undefined) continue;
      if (track[field] !== draft[field]) values.push({ scope: 'track', slotId: track.slotId, field, baseline: track[field], value: draft[field], title: track.title });
    }
  }
  return values;
}
