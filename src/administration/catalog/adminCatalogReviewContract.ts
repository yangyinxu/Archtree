import { ADMIN_IMPORT_LIMITS, type ImportDate, type ImportReceipt, type AdminImportDetail, type ImportWorkbenchFilter } from '../import/adminImportContract';
import type { ImportDraftV2, ImportSuggestionV2 } from '../import/adminImportDraft';

/** A private metadata review targets existing catalog identities, never upload/publication slots. */
export type CatalogReviewField = {
    scope: 'album' | 'track'; slotId: string | null; field: 'title' | 'releaseDate' | 'discNumber' | 'trackNumber';
};
/** At most the two Album fields and three per Track. */
export const CATALOG_REVIEW_MAX_FIELDS = 2 + 3 * ADMIN_IMPORT_LIMITS.files;
/** discNumber absent: not captured (a review created before Disc Numbers were captured); null: the Track stored none. */
export type CatalogReviewSourceTrack = { slotId: string; id: string; revision: string; title: string; discNumber?: number | null; trackNumber: number | null; originalFileName: string | null };
export type CatalogReviewSource = {
    album: { id: string; revision: string; title: string; releaseDate: ImportDate | null; visibility: 'public' | 'hidden' };
    tracks: CatalogReviewSourceTrack[];
};
export type CatalogReviewApplied = { operationId: string; at: string; fields: CatalogReviewField[] };
export type CatalogReviewReceipt = Omit<ImportReceipt, 'kind'> & { kind: 'create' | 'edit' | 'analyze' | 'adopt' | 'cancel-analysis' | 'apply' };
export type CatalogReviewDetail = {
    id: string; revision: number; createdAt: string; updatedAt: string; startedByMe: boolean;
    state: 'reviewing' | 'applied'; sourceStatus: 'current' | 'changed' | 'unavailable'; source: CatalogReviewSource; draft: ImportDraftV2;
    analysis: AdminImportDetail['analysis']; suggestions: ImportSuggestionV2[];
    capabilities: { analysis: boolean; apply: boolean }; applied: CatalogReviewApplied | null;
    receipts: CatalogReviewReceipt[];
};
export type CatalogReviewResponse = { item: CatalogReviewDetail; receipt: CatalogReviewReceipt | null };
export type CatalogReviewWorkbench = {
    items: Array<Pick<CatalogReviewDetail, 'id' | 'revision' | 'createdAt' | 'updatedAt' | 'startedByMe' | 'state' | 'analysis'> &
        { albumId: string; title: string; pendingSuggestions: number }>;
    counts: Record<ImportWorkbenchFilter, number>; nextCursor: string | null;
};

/** POST /catalog-reviews; source data, Credits context and naming evidence are read from the server. */
export type CreateCatalogReview = { operationId: string; albumId: string; expectedRevision: string };
/**
 * PATCH /catalog-reviews/:id: the whole Draft v2. Its Artist entries, label and visibility must equal the saved review's: they
 * are read-only context, never an Artist, Credit or visibility mutation.
 */
export type EditCatalogReview = { operationId: string; expectedRevision: number; draft: ImportDraftV2 };
/** POST /catalog-reviews/:id/apply. Only these explicitly selected saved values may reach the catalog. */
export type ApplyCatalogReview = { operationId: string; expectedRevision: number; fields: CatalogReviewField[] };
// GET list accepts the same filter/startedByMe/q/limit/cursor as imports; it only lists catalog reviews.
// GET detail, POST analyze, adopt and cancel-analysis mirror import operation/revision requests.
// Every endpoint returns private no-store data; no asset, duplicate-decision or publication endpoint exists.
