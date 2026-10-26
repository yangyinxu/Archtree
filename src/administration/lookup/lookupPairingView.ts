/**
 * The hand-pairing read of an existing-Album review's lookup candidate (GET /catalog-reviews/:id/lookup/candidates/:key/pairing,
 * catalogReviewLookupRequests.ts): the rows the candidate's stored release offers as an expected tracklist, exactly the rows choosing
 * it writes, and per member in Album (manifest) order its saved title, captured duration, saved Disc and Track Number and the rows it
 * may take (lookupPairingOptions over the review's ranking evidence: its own numbers constrain, numbers lookup wrote do not, position
 * hints are not read), closest duration first, with the row every maximum pairing gives it, and whether a Disc Number can be saved
 * for it (`discSavable`: only where the review captured one, as a review save refuses any other change of it). `run` is the completed
 * run a choice names and `revision` the review revision a save binds to, both from the same snapshot. Texts come only from the
 * stored release (row titles) and the review's saved draft (member titles); nothing identifies the release, its tracks or recordings
 * beyond the candidate key the request named. Refusals: a review not in the current format, no completed run, or a key that is not
 * one of its candidates, 404 ADMIN_CATALOG_REVIEW_NOT_FOUND; a candidate without fetched details of the release its key names, or
 * whose release offers no expected tracklist within its bounds, 409 ADMIN_IMPORT_LOOKUP_CANDIDATE_INCOMPLETE. Pure: no request and no
 * database call.
 */
import { AdminImportError } from '../import/adminImportContract';
import { CATALOG_REVIEW_DRAFT_V3 } from '../import/adminImportDraft';
import { catalogReviewSourceView, importDraftV2View, importDraftVersion, legacyManifestView } from '../import/adminImportDraftCompat';
import type { AdminImportDocument } from '../import/adminImportService';
import { catalogReviewFileEvidence } from './lookupReviewEvidence';
import { expectedTracklistFromRelease, lookupPairingOptions } from './lookupSubset';
import { lookupCandidateApplicable } from './lookupValueApplication';
import type { MetadataLookupRecord } from './metadataLookupRecord';

export type CatalogReviewPairingPosition = { disc: number; track: number };
/** The hand-pairing read; `run` is the run a choice names and `revision` the review revision a save binds to. */
export type CatalogReviewPairingResponse = {
    run: number; revision: number;
    rows: (CatalogReviewPairingPosition & { title: string; durationMs: number | null })[];
    members: {
        slotId: string; title: string; durationMs: number | null; saved: { disc: number | null; track: number | null }; discSavable: boolean;
        options: (CatalogReviewPairingPosition & { deltaMs: number | null })[]; forced: CatalogReviewPairingPosition | null;
    }[];
};

const position = (value: { discNumber: number; trackNumber: number }): CatalogReviewPairingPosition => ({ disc: value.discNumber, track: value.trackNumber });

/** The hand-pairing read of candidate `key` from a review and its lookup record (only that candidate need be present). */
export function catalogReviewPairingView(doc: AdminImportDocument, record: Pick<MetadataLookupRecord, 'run' | 'state' | 'candidates'> | null,
    key: string): CatalogReviewPairingResponse {
    const candidate = importDraftVersion(doc) === CATALOG_REVIEW_DRAFT_V3 && record?.state === 'complete' && Array.isArray(record.candidates)
        ? record.candidates.find(item => item?.key === key) : undefined;
    if (!record || !candidate) throw new AdminImportError(404, 'ADMIN_CATALOG_REVIEW_NOT_FOUND');
    const tracklist = lookupCandidateApplicable(candidate) ? expectedTracklistFromRelease(candidate.release!) : null;
    const members = catalogReviewFileEvidence(doc), options = tracklist && 'rows' in tracklist ? lookupPairingOptions(tracklist.rows, members) : null;
    // A stored review holds at most 100 members and an expected tracklist at most 100 rows, so the bound refuses only malformed data.
    if (!tracklist || !('rows' in tracklist) || !options) throw new AdminImportError(409, 'ADMIN_IMPORT_LOOKUP_CANDIDATE_INCOMPLETE');
    const saved = importDraftV2View(doc.draft, legacyManifestView(doc.manifest), doc._id.toHexString()).tracks;
    // A review captured before Disc Numbers were captured keeps them as shown (parseCatalogReviewChanges), so only a Track Number saves.
    const captured = new Set(catalogReviewSourceView(doc.catalogSource).tracks.filter(track => track.discNumber !== undefined).map(track => track.slotId));
    return {
        run: record.run, revision: doc.revision,
        rows: tracklist.rows.map(row => ({ ...position(row), title: row.title, durationMs: row.durationMs })),
        members: members.map((member, index) => {
            const track = saved.find(item => item.slotId === member.slotId), choice = options[index];
            return {
                slotId: member.slotId, title: track?.title ?? '', durationMs: member.durationMs,
                saved: { disc: track?.discNumber ?? null, track: track?.trackNumber ?? null }, discSavable: captured.has(member.slotId),
                options: choice.options.map(option => ({ ...position(option), deltaMs: option.deltaMs })), forced: choice.forced && position(choice.forced)
            };
        })
    };
}
