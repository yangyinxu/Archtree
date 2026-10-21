/**
 * Administrator metadata lookup requests behind /catalog-reviews/:id/lookup: reading an existing-Album review's allowlisted lookup
 * view with its summary, submitting a name and retrying. Each change runs inside the review protocol (mutateAdminProject with the
 * review policy, never the import protocol), so it is one review receipt (`lookup` or `lookup-retry`) and one transaction with the
 * lookup record and the review's conversion to format 3: a refusal writes nothing, and a lost response replays. A review run
 * stores and ranks candidates only; nothing here applies one.
 */
import { ObjectId } from 'mongodb';
import { metadataLookupConfiguration, type MetadataLookupConfiguration } from '../../config/metadataLookup';
import { catalogReviewProjectPolicy } from '../catalog/adminCatalogReviewService';
import type { CatalogReviewResponse } from '../catalog/adminCatalogReviewContract';
import { AdminImportError, objectId } from '../import/adminImportContract';
import { importCollection, importLookupRecord, mutateAdminProject, parseAdminProjectMutation, withImportAdmin } from '../import/adminImportService';
import { catalogReviewLookupView, type CatalogReviewLookupView } from './lookupView';
import { lookupAnswersNeeded } from './lookupValueApplication';
import { parseLookupSubmission } from './metadataLookupRequests';
import { lookupRunActive } from './metadataLookupRecord';
import { queueMetadataLookup } from './metadataLookupService';

/**
 * What a review waits for: an active run (`waiting.lookup`, from the run's own state: one that can still send a request, as apply
 * checks) or analysis (queued, running, or a stopped call still settling, as apply checks), the answers lookup needs, and whether
 * this server offers lookup at all.
 */
export type CatalogReviewLookupSummary = { waiting: { lookup: boolean; analysis: boolean }; needsAnswer: { tie: boolean; conflicts: string[] }; lookupAvailable: boolean };
export type CatalogReviewLookupResponse = { lookup: CatalogReviewLookupView | null; revision: number; summary: CatalogReviewLookupSummary };
const notFound = () => new AdminImportError(404, 'ADMIN_CATALOG_REVIEW_NOT_FOUND');

/**
 * The review's lookup view (null before any run), its revision and its summary, read in one snapshot. The review is read without
 * its server-only capture; an applied review reads too. A malformed ID or a project that is not a review is not found.
 */
export async function getCatalogReviewLookup(actor: string, id: string, configuration: () => MetadataLookupConfiguration = metadataLookupConfiguration): Promise<CatalogReviewLookupResponse> {
    if (!objectId(id)) throw notFound();
    return withImportAdmin(actor, async session => {
        const doc = await importCollection().findOne({ _id: new ObjectId(id), purpose: 'catalogReview' }, { session, projection: { catalogCapture: 0 } });
        if (!doc) throw notFound();
        const stored = await importLookupRecord(doc._id, session), needed = lookupAnswersNeeded(stored, doc, { append: false });
        const slots = new Set((Array.isArray(doc.manifest?.files) ? doc.manifest.files : []).map(file => file.slotId));
        const available = configuration().available, analysis = doc.analysis;
        return {
            lookup: stored ? catalogReviewLookupView(stored, doc) : null, revision: doc.revision,
            summary: {
                // The run's own state, never the review's gate, which an earlier release's worker may leave blocking; analysis also
                // waits for a stopped call the worker still settles, which apply refuses too.
                waiting: { lookup: lookupRunActive(stored, new Date(), available),
                    analysis: analysis?.state === 'queued' || analysis?.state === 'running' || (Array.isArray(analysis?.chunks) && analysis.chunks.some(chunk => chunk?.state === 'inflight')) },
                needsAnswer: { tie: needed.tie, conflicts: needed.conflicts.filter(path => !path.startsWith('tracks.') || slots.has(path.split('.')[1])) },
                lookupAvailable: available
            }
        };
    });
}

/**
 * `{operationId, expectedRevision, kind, text}`: looks up a submitted Album or song name with the review's primary Artist names,
 * replacing the previous run. A malformed body rejects like every other refusal.
 */
export async function submitCatalogReviewLookup(actor: string, id: string, raw: unknown): Promise<CatalogReviewResponse> {
    const { body, submitted } = parseLookupSubmission(raw);
    return mutateAdminProject(actor, id, body, 'lookup', async (doc, session) => {
        await queueMetadataLookup(doc, { kind: 'submit', actorId: actor, operationId: body.operationId, submitted }, session);
    }, catalogReviewProjectPolicy);
}

/** `{operationId, expectedRevision}`: repeats the last run's input and queries as a new run. */
export async function retryCatalogReviewLookup(actor: string, id: string, raw: unknown): Promise<CatalogReviewResponse> {
    const body = parseAdminProjectMutation(raw, []);
    return mutateAdminProject(actor, id, body, 'lookup-retry', async (doc, session) => {
        await queueMetadataLookup(doc, { kind: 'retry', actorId: actor, operationId: body.operationId }, session);
    }, catalogReviewProjectPolicy);
}
