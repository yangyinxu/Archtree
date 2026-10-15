import type { ImportDate, ImportDraft, ImportReceipt, ImportSuggestion, AdminImportDetail, ImportWorkbenchFilter } from './adminImportContract';

/** A private metadata review targets existing catalog identities, never upload/publication slots. */
export type CatalogReviewField = {
    scope: 'album' | 'track'; slotId: string | null; field: 'title' | 'releaseDate' | 'trackNumber';
};
export type CatalogReviewSource = {
    album: { id: string; revision: string; title: string; releaseDate: ImportDate | null; visibility: 'public' | 'hidden' };
    tracks: { slotId: string; id: string; revision: string; title: string; trackNumber: number | null; originalFileName: string | null }[];
};
export type CatalogReviewApplied = { operationId: string; at: string; fields: CatalogReviewField[] };
export type CatalogReviewReceipt = Omit<ImportReceipt, 'kind'> & { kind: 'create' | 'edit' | 'analyze' | 'adopt' | 'cancel-analysis' | 'apply' };
export type CatalogReviewDetail = {
    id: string; revision: number; createdAt: string; updatedAt: string; startedByMe: boolean;
    state: 'reviewing' | 'applied'; sourceStatus: 'current' | 'changed' | 'unavailable'; source: CatalogReviewSource; draft: ImportDraft;
    analysis: AdminImportDetail['analysis']; suggestions: ImportSuggestion[];
    capabilities: { analysis: boolean; apply: boolean }; applied: CatalogReviewApplied | null;
    receipts: CatalogReviewReceipt[];
};
export type CatalogReviewResponse = { item: CatalogReviewDetail; receipt: CatalogReviewReceipt | null };
export type CatalogReviewWorkbench = {
    items: Array<Pick<CatalogReviewDetail, 'id' | 'revision' | 'createdAt' | 'updatedAt' | 'startedByMe' | 'state' | 'analysis'> &
        { albumId: string; title: string; pendingSuggestions: number }>;
    counts: Record<ImportWorkbenchFilter, number>; nextCursor: string | null;
};

/** POST /catalog-reviews; source data and naming evidence are read from the server. */
export type CreateCatalogReview = { operationId: string; albumId: string; expectedRevision: string };
/** PATCH /catalog-reviews/:id. Visibility remains fixed; artistName is context, never an Artist mutation. */
export type EditCatalogReview = { operationId: string; expectedRevision: number; draft: ImportDraft };
/** POST /catalog-reviews/:id/apply. Only these explicitly selected saved values may reach the catalog. */
export type ApplyCatalogReview = { operationId: string; expectedRevision: number; fields: CatalogReviewField[] };
// GET list accepts the same filter/startedByMe/q/limit/cursor as imports; it only lists catalog reviews.
// GET detail, POST analyze, adopt and cancel-analysis mirror import operation/revision requests.
// Every endpoint returns private no-store data; no asset, duplicate-decision or publication endpoint exists.
