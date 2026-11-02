import type { ReviewDraft } from './catalogReviewApi';
import type { ProposedValues } from './catalogReviewApplyModel';

/**
 * The review page's editor buffer apart from the proposal (owner rules: docs/business-rules.md, Catalog Visibility and
 * Administration, the proposal on open): the administrator's own edits are kept sparse over the saved draft, so a value they
 * cleared stays cleared over a proposal, while the numbers proposed from titles stay derived (catalogReviewProposal.ts, in the
 * proposal table's chunk) and are never edits. Only the edits make the draft unsaved. Kept apart from the proposal and the Update
 * selection's model, so the page's chunk carries neither the title parser nor that model.
 */

type Track = ReviewDraft['tracks'][number];
type Numbers = Partial<Pick<Track, 'discNumber' | 'trackNumber'>>;
/** The editable values the administrator set, null included (a cleared value), by Album field and by member slot. */
export type ReviewEdits = { album?: Partial<Pick<ReviewDraft['album'], 'title' | 'releaseDate'>>; tracks?: Record<string, Partial<Pick<Track, 'title' | 'discNumber' | 'trackNumber'>>> };
/**
 * What the proposal table (CatalogReviewProposalTable.tsx) derives for one editor state (`base` and `edits`, compared by reference): the
 * draft it shows (every proposed number, then the edits), the title proposal's Update selection defaults and the numbers it
 * proposes by slot.
 */
export type ReviewEditorView = { base: ReviewDraft; edits: ReviewEdits; shown: ReviewDraft; proposed: ProposedValues; numbers: Record<string, Numbers> };
/**
 * What the update range (CatalogReviewRange.tsx) derives for one editor state: the draft a save writes (the edits and the selected
 * proposed numbers only) and how many changes are selected.
 */
export type ReviewEditorDerived = { base: ReviewDraft; edits: ReviewEdits; draft: ReviewDraft; count: number };

/** An Album with this many members folds its uniform proposed rows per disc, in the proposal table and in the update range. */
export const longAlbum = (members: number) => members >= 25;

/** `draft` with the administrator's edits written over it. */
export const withEdits = (draft: ReviewDraft, edits: ReviewEdits): ReviewDraft => ({ ...draft, album: { ...draft.album, ...edits.album },
  tracks: draft.tracks.map(track => ({ ...track, ...edits.tracks?.[track.slotId] })) });

/**
 * `edits` with each editable value of `next` that differs from `shown` (the draft the editor showed) recorded, a cleared value as
 * null; a value left alone stays as it was, so a proposal it showed stays a proposal.
 */
export function recordEdits(edits: ReviewEdits, shown: ReviewDraft, next: ReviewDraft): ReviewEdits {
  const differs = (left: unknown, right: unknown) => JSON.stringify(left) !== JSON.stringify(right);
  let { album, tracks } = edits;
  for (const field of ['title', 'releaseDate'] as const) if (differs(shown.album[field], next.album[field])) album = { ...album, [field]: next.album[field] };
  for (const track of next.tracks) for (const field of ['title', 'discNumber', 'trackNumber'] as const) {
    const before = shown.tracks.find(value => value.slotId === track.slotId);
    if (before && differs(before[field], track[field])) tracks = { ...tracks, [track.slotId]: { ...tracks?.[track.slotId], [field]: track[field] } };
  }
  return { album, tracks };
}

/**
 * The draft a save writes: the saved draft with each proposed number (`numbers`, by slot) still empty there and `selected` by its
 * Update item key (`track:<slot>:<field>`), then the edits; an unselected proposal is never saved.
 */
export const withProposedNumbers = (base: ReviewDraft, edits: ReviewEdits, numbers: Readonly<Record<string, Numbers>>, selected: (key: string) => boolean) =>
  withEdits({ ...base, tracks: base.tracks.map(track => {
    const pick = (field: 'discNumber' | 'trackNumber') => track[field] ?? (selected(`track:${track.slotId}:${field}`) ? numbers[track.slotId]?.[field] ?? null : null);
    return { ...track, discNumber: pick('discNumber'), trackNumber: pick('trackNumber') };
  }) }, edits);
