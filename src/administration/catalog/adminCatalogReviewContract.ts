import { ADMIN_IMPORT_LIMITS, type ImportDate, type ImportReceipt, type AdminImportDetail, type ImportWorkbenchFilter } from '../import/adminImportContract';
import type { ImportArtistEntry, ImportDraftV2, ImportSuggestionV2 } from '../import/adminImportDraft';
import type { ExpectedTracklistRow } from '../../services/catalog/albumExpectedTracklist';
import type { CatalogCreditRole } from '../../models/catalogCredit';

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
/** `lookup` and `lookup-retry` receipts are stored and replayed, but the detail never lists them (LEGACY_REVIEW_RECEIPT_KINDS). */
export type CatalogReviewReceipt = Omit<ImportReceipt, 'kind'> & { kind: 'create' | 'edit' | 'analyze' | 'adopt' | 'cancel-analysis' | 'apply' | 'lookup' | 'lookup-retry' };
/**
 * A review's draft: Draft v2, plus the review-only values a review captured for metadata lookup holds (format 3): the Album's
 * expected tracklist rows (null without one) and each member's track Artist entries. Formats 1 and 2 carry neither key.
 */
export type CatalogReviewDraft = Omit<ImportDraftV2, 'album' | 'tracks'> & {
    album: ImportDraftV2['album'] & { expectedTracklist?: ExpectedTracklistRow[] | null };
    tracks: (ImportDraftV2['tracks'][number] & { artists?: ImportArtistEntry[] })[];
};
export type CatalogReviewDetail = {
    id: string; revision: number; createdAt: string; updatedAt: string; startedByMe: boolean;
    state: 'reviewing' | 'applied'; sourceStatus: 'current' | 'changed' | 'unavailable'; source: CatalogReviewSource; draft: CatalogReviewDraft;
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
 * PATCH /catalog-reviews/:id: the changed editable values, each with the value the editor started from (`base`): the Album title
 * and date and each Track's title, Disc Number and Track Number. Artist entries, the label, visibility, the expected tracklist and
 * member Artist entries are never sent. The legacy body `{operationId, expectedRevision, draft}` (the whole Draft v2) is admitted
 * only for a format-2 review.
 */
export type EditCatalogReview = { operationId: string; expectedRevision: number; changes: { path: string; base: unknown; value: unknown }[] };
/** POST /catalog-reviews/:id/apply. Only these explicitly selected saved values may reach the catalog. */
export type ApplyCatalogReview = { operationId: string; expectedRevision: number; fields: CatalogReviewField[] };

// Server-only capture of a review admitted to metadata lookup (stored at `catalogCapture`, never projected).
/** A ready credited record as read at capture: its trimmed name, keepable MusicBrainz ID and importCandidateRevision. */
export type CatalogReviewCapturedSubject = { name: string; musicBrainzId: string | null; revision: string };
/** One stored Credit in stored order; `entryKey` names the draft entry showing it, and `subject` is null for a record not ready. */
export type CatalogReviewCapturedCredit = {
    creditId: string; subjectType: 'artist' | 'organization'; subjectId: string; role: CatalogCreditRole;
    joinPhrase: string | null; entryKey: string | null; subject: CatalogReviewCapturedSubject | null;
};
/** `credits` null: the stored list was unreadable. `artistsComplete`: the draft shows every primary and featured Artist Credit. */
export type CatalogReviewCapturedCredits = { credits: CatalogReviewCapturedCredit[] | null; artistsComplete: boolean };
/** A member's file duration: exact milliseconds (precision 0) or a legacy whole-second text (precision 1000). */
export type CatalogReviewMemberDuration = { durationMs: number; durationPrecisionMs: 0 | 1000 };
/** `attributionStatus` null: absent or unrecognized; an explicit `unknown` stays apart from it. */
export type CatalogReviewMemberCapture = CatalogReviewCapturedCredits & {
    slotId: string; duration: CatalogReviewMemberDuration | null; attributionStatus: 'documented' | 'unknown' | null;
};
/**
 * `album.label`: `none` when the Album has no label Credit, `first` when the draft's label is its first label Credit, and `other`
 * when the label is read-only context (including unreadable Credits). One member per source track, in source order.
 */
export type CatalogReviewCapture = {
    capturedAt: Date;
    album: CatalogReviewCapturedCredits & { label: 'none' | 'first' | 'other'; expectedTracklist: ExpectedTracklistRow[] | null };
    members: CatalogReviewMemberCapture[];
};

// GET list accepts the same filter/startedByMe/q/limit/cursor as imports; it only lists catalog reviews.
// GET detail, POST analyze, adopt and cancel-analysis mirror import operation/revision requests.
// GET /:id/lookup reads the review's lookup view and summary; POST /:id/lookup ({operationId, expectedRevision, kind, text}) and
// POST /:id/lookup/retry ({operationId, expectedRevision}) queue a run with a `lookup` or `lookup-retry` receipt (8 KB bodies);
// GET /:id/lookup/candidates/:key/artwork is a transient WebP preview (catalogReviewLookupRequests.ts, adminImportLookupCover.ts).
// Every endpoint returns private no-store data; no asset, duplicate-decision or publication endpoint exists.
