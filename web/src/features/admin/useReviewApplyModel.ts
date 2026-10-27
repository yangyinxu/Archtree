import { useQuery } from '@tanstack/react-query';
import { useAdminAccess } from './AdminAccess';
import type { CatalogReview } from './catalogReviewApi';
import { reviewApplyModel, type ApplyChoice } from './catalogReviewApplyModel';
import { catalogReviewCandidatesQuery, catalogReviewSummaryQuery } from './catalogReviewSummaryQuery';

/**
 * The Update original Album step's model and the reads it rests on (the summary's cached read, never polled from here, and the
 * identity read of a review captured for lookup whose source is current), shared by that step and the step bar's count
 * (CatalogReviewApplyCount in CatalogReviewApply.tsx), so both count the same changes: the selected fields and members.
 */
export function useReviewApplyModel(item: CatalogReview, choices: Readonly<Record<string, ApplyChoice>>) {
  const access = useAdminAccess(), captured = item.draft.album.expectedTracklist !== undefined && item.state === 'reviewing';
  // The summary's own read polls; this observer only shares its cached result, so whether the browser is online does not matter here.
  const summary = useQuery({ ...catalogReviewSummaryQuery(access, item, true), refetchInterval: false, enabled: captured });
  const identity = useQuery({ ...catalogReviewCandidatesQuery(access, item), enabled: captured && item.sourceStatus === 'current' });
  const read = summary.isPlaceholderData ? undefined : summary.data, rows = identity.isPlaceholderData ? undefined : identity.data;
  const model = reviewApplyModel({ item, lookup: read?.lookup ?? null, summary: read ?? null, waiting: read?.summary.waiting ?? null, identity: rows ?? null, choices });
  return { model, count: model.selection.fields.length + model.selection.memberCredits.length, identity: rows ?? null,
    reads: captured && item.sourceStatus === 'current' ? [summary, identity] : [] };
}
