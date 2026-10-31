import type { ReactNode } from 'react';
import { useCatalogReviewPrepare, type CatalogReviewPrepareInput } from './useCatalogReviewPrepare';

/** What requesting the update returns (useCatalogReviewPrepare.ts): its state and its actions. */
export type CatalogReviewPrepare = ReturnType<typeof useCatalogReviewPrepare>;

/**
 * Runs the review's prepare and apply state machine (useCatalogReviewPrepare.ts) as its own lazy chunk, so the action bar's chunk,
 * which carries the Update model, stays within the JavaScript budget; `children` renders the bar from its state on every render.
 * It stays mounted while the review page shows a review, as the state lives here (a pending save or apply resumes after a remount).
 */
export function CatalogReviewPrepareControl({ input, children }: { input: CatalogReviewPrepareInput; children: (prepare: CatalogReviewPrepare) => ReactNode }) {
  return <>{children(useCatalogReviewPrepare(input))}</>;
}
