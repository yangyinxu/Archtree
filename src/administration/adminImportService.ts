import { startAdminWorker, type AdminWorkTracker } from './adminWorkerLifecycle';
import { createHash, randomUUID } from 'node:crypto';
import { ObjectId, type ClientSession, type Db, type Filter } from 'mongodb';
import { getDatabaseClient, getDb } from '../infrastructure/database';
import { readyAudioStorageFilter } from '../utils/audioStorageKey';
import { readyArtistLifecycleFilter } from '../services/artistReferenceFenceService';
import { readyAlbumLifecycleFilter } from '../services/albumReferenceFenceService';
import { ADMIN_IMPORT_LIMITS as LIMITS, AdminImportError, cleanText, defaultDraft, exact, importEnabled, invalidImport, objectId, parseDraft, parseManifest, record, uuid, type AdminImportDetail, type AdminImportResponse, type ImportAnalysisState, type ImportDraft, type ImportDuplicateCandidate, type ImportDuplicateDecision, type ImportEmbeddedTags, type ImportIssue, type ImportManifest, type ImportReceipt, type ImportSuggestion, type ImportWorkbenchFilter, type ImportWorkbenchResponse } from './adminImportContract';
import { type AnalysisInput, type ImportAnalysisProvider, ImportProviderError, OpenAiImportAnalysisProvider } from './adminImportProvider';
import type { ImportMedia } from './adminImportMediaTypes';
import { importPrivateStorageReady } from './adminImportMediaTypes';

type Receipt = ImportReceipt & { actorId: string; hash: string; at: Date; selection?: { generation: number; acceptedIds: string[]; rejectedIds: string[] } };
type Chunk = { index: number; slots: string[]; album: boolean; hash: string; state: 'pending' | 'inflight' | 'complete' | 'failed' | 'unknown'; attemptId: string | null; startedAt: Date | null; completedAt: Date | null };
type Analysis = { state: ImportAnalysisState; generation: number; operationId: string | null; actorId: string | null; grantExpiresAt: Date | null; baseline: ImportDraft | null; tags?: { slotId: string; tags: ImportEmbeddedTags }[]; chunks: Chunk[]; issue: ImportIssue; leaseOwner: string | null; leaseUntil: Date | null };
export type AdminImportDocument = { _id: ObjectId; actorId: string; revision: number; createdAt: Date; updatedAt: Date; manifest: ImportManifest; draft: ImportDraft; analysis: Analysis; analysisHistory: Analysis[]; attemptsUsed: number; suggestions: ImportSuggestion[]; decisions: ImportDuplicateDecision[]; receipts: Receipt[]; recoveryReceipts?: Receipt[]; media?: ImportMedia };
export const importCollection = () => getDb()!.collection<AdminImportDocument>('adminAlbumImports');
const collection = importCollection;
export const importDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const digest = importDigest;
const idleAnalysis = (): Analysis => ({ state: 'idle', generation: 0, operationId: null, actorId: null, grantExpiresAt: null, baseline: null, chunks: [], issue: null, leaseOwner: null, leaseUntil: null });
const notFound = () => new AdminImportError(404, 'ADMIN_IMPORT_NOT_FOUND');
const conflict = (code = 'ADMIN_IMPORT_REVISION_CONFLICT') => new AdminImportError(409, code);
const isActive = (doc: AdminImportDocument) => ['queued', 'running'].includes(doc.analysis.state);
const occupiedAnalysis: Filter<AdminImportDocument> = { $or: [{ 'analysis.state': { $in: ['queued', 'running'] } }, { 'analysis.chunks.state': 'inflight' }] };
const admit = () => { if (!importEnabled()) throw new AdminImportError(503, 'ADMIN_IMPORTS_DISABLED'); };
const idValue = (id: string) => { if (!objectId(id)) throw notFound(); return new ObjectId(id); };

/** A transaction write fence conflicts with account deletion/role changes, including between lookup and commit. */
export async function touchImportAdmin(actorId: string, session: ClientSession) {
    if (!objectId(actorId)) throw new AdminImportError(403, 'ADMIN_IMPORT_ADMIN_REQUIRED');
    const result = await getDb()!.collection('users').updateOne({ _id: new ObjectId(actorId), role: 'admin' }, { $inc: { adminImportRevision: 1 } }, { session });
    if (result.matchedCount !== 1) throw new AdminImportError(403, 'ADMIN_IMPORT_ADMIN_REQUIRED');
}
const touchAdmin = touchImportAdmin;
export async function withImportAdmin<T>(actorId: string, work: (session: ClientSession) => Promise<T>): Promise<T> {
    const session = getDatabaseClient().startSession(); let result!: T;
    try { await session.withTransaction(async () => { await touchAdmin(actorId, session); result = await work(session); }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, maxCommitTimeMS: 10_000 }); return result; }
    finally { await session.endSession(); }
}
const withAdmin = withImportAdmin;

/** Required indexes are exported so startup uses the repository's central index verifier. */
export const adminImportIndexes = [
    { collection: 'adminAlbumImports', keys: { createdAt: -1, _id: -1 }, options: { name: 'admin_import_inventory' }, required: true },
    { collection: 'adminAlbumImports', keys: { 'analysis.state': 1, 'analysis.leaseUntil': 1, createdAt: 1 }, options: { name: 'admin_import_worker' }, required: true },
    { collection: 'adminAlbumImports', keys: { 'analysis.actorId': 1, 'analysis.state': 1 }, options: { name: 'admin_import_actor_admission' }, required: true },
    { collection: 'adminAlbumImports', keys: { 'media.publication.state': 1, 'media.publication.leaseUntil': 1 }, options: { name: 'admin_import_publication_worker' }, required: true }
] as const;
export async function initializeAdminImportStorage(db: Db) {
    await db.collection<{ _id: string; revision: number }>('adminImportAnalysisSlots').updateOne({ _id: 'admission' }, { $setOnInsert: { revision: 0 } }, { upsert: true });
}

export function adminImportDto(doc: AdminImportDocument, actorId: string, providerAvailable = Boolean(process.env.OPENAI_API_KEY?.trim())): AdminImportDetail {
    return {
        id: doc._id.toHexString(), revision: doc.revision, createdAt: doc.createdAt.toISOString(), updatedAt: doc.updatedAt.toISOString(), startedByMe: doc.actorId === actorId,
        manifest: doc.manifest, draft: doc.draft,
        analysis: { state: doc.analysis.state, generation: doc.analysis.generation, operationId: doc.analysis.operationId, completedChunks: doc.analysis.chunks.filter(chunk => chunk.state === 'complete').length, totalChunks: doc.analysis.chunks.length, attemptsUsed: doc.attemptsUsed, maxAttempts: LIMITS.attempts, issue: doc.analysis.issue },
        suggestions: doc.suggestions.filter(suggestion => suggestion.generation === doc.analysis.generation), decisions: doc.decisions,
        upload: { ready: (doc.media?.assets ?? []).filter(asset => doc.manifest.files.some(file => file.slotId === asset.slotId) && asset.state === 'ready').length, total: doc.manifest.files.length, available: importEnabled() && importPrivateStorageReady() }, publication: doc.media?.publication?.state ?? 'notStarted',
        publicationRecovery: doc.media?.publication ? { operationId: doc.media.publication.operationId, cleanupPending: Boolean(doc.media.publication.cleanupPending), startedByMe: doc.media.publication.actorId === actorId } : null,
        assets: (doc.media?.assets ?? []).map(({ slotId, state, byteLength, sha256, contentType, tags, recovery, operationId, actorId: owner }) => ({ slotId, state, byteLength, sha256, contentType, tags: tags ?? null, recovery: { operationId: recovery?.operationId ?? operationId, expectedRevision: recovery?.expectedRevision ?? 1, kind: recovery?.kind ?? 'upload', startedByMe: (recovery?.actorId ?? owner) === actorId } })), selectedCoverSlotId: doc.media?.selectedCoverSlotId ?? null,
        published: doc.media?.publication?.state === 'complete' ? { albumId: doc.media.publication.albumId, artistId: doc.media.publication.artistId, trackIds: doc.media.publication.tracks.map(track => track.id) } : null,
        capabilities: { analysis: importEnabled() && providerAvailable, upload: importEnabled() && importPrivateStorageReady(), publish: importEnabled() && importPrivateStorageReady() && (doc.media?.publicationHistory?.length ?? 0) + (doc.media?.publication ? 1 : 0) < LIMITS.publications }, receipts: [...doc.receipts, ...(doc.recoveryReceipts ?? [])].sort((a, b) => a.revision - b.revision).slice(-LIMITS.receipts).map(({ operationId, kind, revision }) => ({ operationId, kind, revision }))
    };
}
const response = (doc: AdminImportDocument, actor: string, receipt: ImportReceipt | null = null): AdminImportResponse => ({ item: adminImportDto(doc, actor), receipt: receipt ? { operationId: receipt.operationId, kind: receipt.kind, revision: receipt.revision } : null });
function mutation(raw: unknown, extra: string[]) { const body = record(raw); exact(body, ['operationId', 'expectedRevision', ...extra]); if (!uuid(body.operationId) || !Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 1) return invalidImport(); return body as typeof body & { operationId: string; expectedRevision: number }; }

/** Receipt lookup precedes revision checks: an uncertain acknowledgement must replay the original intent. */
export async function mutateAdminImport(actor: string, id: string, body: Record<string, unknown> & { operationId: string; expectedRevision: number }, kind: Receipt['kind'], change: (doc: AdminImportDocument, session: ClientSession) => Promise<void>): Promise<AdminImportResponse> {
    const _id = idValue(id), hash = digest({ kind, body });
    return withAdmin(actor, async session => {
        const doc = await collection().findOne({ _id }, { session }); if (!doc) throw notFound();
        const prior = [...doc.receipts, ...(doc.recoveryReceipts ?? [])].find(receipt => receipt.operationId === body.operationId);
        if (prior) { if (prior.hash !== hash || (prior.actorId !== actor && kind !== 'cleanup')) throw conflict('ADMIN_IMPORT_OPERATION_CONFLICT'); return response(doc, actor, prior); }
        if (doc.revision !== body.expectedRevision) throw conflict();
        const publication = doc.media?.publication;
        if (publication && !['cleanup', 'cancel-publication'].includes(kind)
            && (publication.state !== 'cancelled' || (publication.cleanupPending && !['edit', 'adopt', 'decisions'].includes(kind)))) throw conflict('ADMIN_IMPORT_PUBLICATION_LOCKED');
        // Recovery admits one intent per previously admitted asset/approval; cleanup never consumes new-work capacity.
        const recovery = kind === 'cleanup' || kind === 'cancel-publication';
        if ((recovery ? doc.recoveryReceipts?.length ?? 0 : doc.receipts.length) >= LIMITS.receipts) throw conflict('ADMIN_IMPORT_OPERATION_LIMIT');
        await change(doc, session); doc.revision++; doc.updatedAt = new Date();
        const receipt: Receipt = { operationId: body.operationId, kind, revision: doc.revision, actorId: actor, hash, at: doc.updatedAt }; if (kind === 'adopt') receipt.selection = { generation: body.generation as number, acceptedIds: [...body.selectedIds as string[]], rejectedIds: [...body.rejectIds as string[]] }; if (recovery) (doc.recoveryReceipts ??= []).push(receipt); else doc.receipts.push(receipt);
        const update = await collection().replaceOne({ _id, revision: body.expectedRevision }, doc, { session }); if (update.matchedCount !== 1) throw conflict();
        return response(doc, actor, receipt);
    });
}
const mutate = mutateAdminImport;

export async function createAdminImport(actor: string, raw: unknown): Promise<AdminImportResponse> {
    const input = record(raw); exact(input, ['operationId', 'manifest', 'draft']); if (!uuid(input.operationId)) return invalidImport();
    const manifest = parseManifest(input.manifest), draft = input.draft === undefined ? defaultDraft(manifest) : parseDraft(input.draft, manifest);
    const operationId = input.operationId, _id = new ObjectId(digest({ actor, operationId }).slice(0, 24)), hash = digest({ kind: 'create', manifest, draft, operationId });
    return withAdmin(actor, async session => {
        const previous = await collection().findOne({ _id }, { session });
        if (previous) { const receipt = previous.receipts[0]; if (receipt.hash !== hash || receipt.actorId !== actor) throw conflict('ADMIN_IMPORT_OPERATION_CONFLICT'); return response(previous, actor, receipt); }
        admit();
        const now = new Date(), receipt: Receipt = { operationId, kind: 'create', revision: 1, hash, actorId: actor, at: now };
        const doc: AdminImportDocument = { _id, actorId: actor, revision: 1, createdAt: now, updatedAt: now, manifest, draft, analysis: idleAnalysis(), analysisHistory: [], attemptsUsed: 0, suggestions: [], decisions: [], receipts: [receipt] };
        await collection().insertOne(doc, { session }); return response(doc, actor, receipt);
    });
}
export const getAdminImport = (actor: string, id: string) => withAdmin(actor, async session => { const doc = await collection().findOne({ _id: idValue(id) }, { session }); if (!doc) throw notFound(); return response(doc, actor); });
export const editAdminImport = (actor: string, id: string, raw: unknown) => { const body = mutation(raw, ['draft']); return mutate(actor, id, body, 'edit', async doc => { doc.draft = parseDraft(body.draft, doc.manifest); }); };

const filters: Record<ImportWorkbenchFilter, Record<string, unknown>> = {
    all: {}, analyzing: { 'analysis.state': { $in: ['queued', 'running'] } }, awaitingReview: { $or: [{ 'media.publication': { $exists: false } }, { 'media.publication.state': 'cancelled' }] },
    needsAttention: { $or: [{ 'analysis.state': 'needsAttention' }, { 'media.publication.state': 'needsAttention' }, { 'media.publication.state': 'cancelled', 'media.publication.cleanupPending': true }, { 'media.assets.state': { $in: ['failed', 'unknown', 'cleanupFailed'] } }] }, completed: { 'media.publication.state': 'complete' }
};
export async function listAdminImports(actor: string, query: Record<string, unknown>): Promise<ImportWorkbenchResponse> {
    exact(query, ['filter', 'startedByMe', 'q', 'limit', 'cursor']);
    const filter = query.filter ?? 'all'; if (!Object.keys(filters).includes(filter as string)) return invalidImport();
    if (query.startedByMe !== undefined && !['true', 'false'].includes(query.startedByMe as string)) return invalidImport();
    const limit = query.limit === undefined ? LIMITS.page : Number(query.limit); if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.page || (query.limit !== undefined && !/^\d{1,2}$/.test(String(query.limit)))) return invalidImport();
    const q = query.q === undefined ? '' : cleanText(query.q, 100, true); const base: Record<string, unknown> = { ...(query.startedByMe === 'true' ? { actorId: actor } : {}) };
    if (q) { const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); base.$or = ['manifest.rootLabel', 'draft.album.title', 'draft.album.artistName'].map(field => ({ [field]: { $regex: escaped, $options: 'i' } })); }
    let page: Record<string, unknown> = {};
    if (query.cursor !== undefined) {
        if (typeof query.cursor !== 'string' || query.cursor.length > 500 || !/^[A-Za-z0-9_-]+$/.test(query.cursor)) return invalidImport();
        try { const cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')); if (!objectId(cursor.id) || typeof cursor.at !== 'string' || !Number.isFinite(Date.parse(cursor.at)) || cursor.scope !== digest({ filter, mine: query.startedByMe === 'true', q })) return invalidImport(); const at = new Date(cursor.at); page = { $or: [{ createdAt: { $lt: at } }, { createdAt: at, _id: { $lt: new ObjectId(cursor.id) } }] }; } catch { return invalidImport(); }
    }
    return withAdmin(actor, async session => {
        const counts = {} as ImportWorkbenchResponse['counts'];
        for (const [name, selector] of Object.entries(filters)) counts[name as ImportWorkbenchFilter] = await collection().countDocuments({ $and: [base, selector] }, { session, maxTimeMS: 3_000 });
        const docs = await collection().find({ $and: [base, filters[filter as ImportWorkbenchFilter], page] }, { session }).sort({ createdAt: -1, _id: -1 }).limit(limit + 1).maxTimeMS(3_000).toArray();
        const hasMore = docs.length > limit; docs.splice(limit); const last = docs[docs.length - 1];
        return { counts, items: docs.map(doc => { const item = adminImportDto(doc, actor); return { id: item.id, revision: item.revision, createdAt: item.createdAt, updatedAt: item.updatedAt, startedByMe: item.startedByMe, analysis: item.analysis, upload: item.upload, publication: item.publication, title: doc.draft.album.title, artistName: doc.draft.album.artistName, rootLabel: doc.manifest.rootLabel, visibility: doc.draft.album.visibility, pendingSuggestions: doc.suggestions.filter(s => s.decision === 'pending').length }; }), nextCursor: hasMore && last ? Buffer.from(JSON.stringify({ id: last._id.toHexString(), at: last.createdAt.toISOString(), scope: digest({ filter, mine: query.startedByMe === 'true', q }) })).toString('base64url') : null };
    });
}

export function analyzeAdminImport(actor: string, id: string, raw: unknown, provider: ImportAnalysisProvider = new OpenAiImportAnalysisProvider()) {
    const body = mutation(raw, []);
    return mutate(actor, id, body, 'analyze', async (doc, session) => {
        admit(); if (!provider.configured()) throw new AdminImportError(503, 'ADMIN_IMPORT_PROVIDER_UNAVAILABLE');
        if (isActive(doc) || doc.analysis.chunks.some(chunk => chunk.state === 'inflight')) throw conflict('ADMIN_IMPORT_ANALYSIS_ACTIVE');
        if (doc.analysis.issue === 'providerOutcomeUnknown') throw conflict('ADMIN_IMPORT_ANALYSIS_OUTCOME_UNKNOWN');
        if (doc.analysis.generation >= LIMITS.generations) throw conflict('ADMIN_IMPORT_BUDGET_EXHAUSTED');
        // The singleton write serializes capacity decisions across actors and server processes.
        const gate = await getDb()!.collection<{ _id: string; revision: number }>('adminImportAnalysisSlots').updateOne({ _id: 'admission' }, { $inc: { revision: 1 } }, { session });
        if (!gate.matchedCount) throw new AdminImportError(503, 'ADMIN_IMPORT_WORKER_UNAVAILABLE');
        if (await collection().countDocuments({ 'analysis.actorId': actor, ...occupiedAnalysis }, { session, limit: 1 })) throw new AdminImportError(429, 'ADMIN_IMPORT_ACTOR_BUSY');
        if (await collection().countDocuments(occupiedAnalysis, { session, limit: 2 }) >= 2) throw new AdminImportError(429, 'ADMIN_IMPORT_CAPACITY');
        const generation = doc.analysis.generation + 1, chunks: Chunk[] = [];
        const tags = (doc.media?.assets ?? []).filter(asset => asset.state === 'ready' && asset.tags && doc.manifest.files.some(file => file.slotId === asset.slotId)).map(asset => ({ slotId: asset.slotId, tags: structuredClone(asset.tags!) }));
        const addChunk = (slots: string[], album: boolean) => { const index = chunks.length; chunks.push({ index, slots, album, hash: digest({ generation, manifest: doc.manifest, baseline: doc.draft, tags, slots, album }), state: 'pending', attemptId: null, startedAt: null, completedAt: null }); };
        addChunk([], true); for (let offset = 0; offset < doc.manifest.files.length; offset += LIMITS.tracksPerChunk) addChunk(doc.manifest.files.slice(offset, offset + LIMITS.tracksPerChunk).map(file => file.slotId), false);
        if (doc.attemptsUsed + chunks.length > LIMITS.attempts) throw conflict('ADMIN_IMPORT_BUDGET_EXHAUSTED');
        if (doc.analysis.generation) doc.analysisHistory.push(structuredClone(doc.analysis));
        doc.analysis = { state: 'queued', generation, operationId: body.operationId, actorId: actor, grantExpiresAt: new Date(Date.now() + LIMITS.grantMs), baseline: structuredClone(doc.draft), tags, chunks, issue: null, leaseOwner: null, leaseUntil: null };
    });
}
export const cancelAdminImportAnalysis = (actor: string, id: string, raw: unknown) => mutate(actor, id, mutation(raw, []), 'cancel-analysis', async doc => { if (isActive(doc)) doc.analysis.state = 'cancelled'; });

function valueAt(draft: ImportDraft, suggestion: ImportSuggestion) { return suggestion.scope === 'album' ? draft.album[suggestion.field as 'title' | 'artistName' | 'releaseDate'] : draft.tracks.find(track => track.slotId === suggestion.slotId)![suggestion.field as 'title' | 'trackNumber']; }
export function adoptAdminImportSuggestions(actor: string, id: string, raw: unknown) {
    const body = mutation(raw, ['generation', 'selectedIds', 'rejectIds']);
    if (!Number.isInteger(body.generation) || !Array.isArray(body.selectedIds) || !Array.isArray(body.rejectIds) || body.selectedIds.length + body.rejectIds.length < 1 || body.selectedIds.length + body.rejectIds.length > 203 || [...body.selectedIds, ...body.rejectIds].some(value => typeof value !== 'string' || !/^[a-f0-9]{24}$/.test(value)) || new Set([...body.selectedIds, ...body.rejectIds]).size !== body.selectedIds.length + body.rejectIds.length) return invalidImport();
    const selected = body.selectedIds as string[], rejected = body.rejectIds as string[];
    return mutate(actor, id, body, 'adopt', async doc => {
        if (doc.analysis.generation !== body.generation) throw conflict('ADMIN_IMPORT_SUGGESTION_STALE');
        const targets = [...selected, ...rejected].map(id => doc.suggestions.find(s => s.id === id && s.generation === body.generation && s.decision === 'pending'));
        if (targets.some(s => !s)) throw conflict('ADMIN_IMPORT_SUGGESTION_STALE');
        for (const suggestion of targets as ImportSuggestion[]) {
            if (selected.includes(suggestion.id)) {
                if (digest(valueAt(doc.draft, suggestion)) !== digest(suggestion.baseline)) throw conflict('ADMIN_IMPORT_FIELD_CONFLICT');
                if (suggestion.scope === 'album') (doc.draft.album as unknown as Record<string, unknown>)[suggestion.field] = suggestion.value;
                else (doc.draft.tracks.find(track => track.slotId === suggestion.slotId)! as unknown as Record<string, unknown>)[suggestion.field] = suggestion.value;
                suggestion.decision = 'accepted';
            } else suggestion.decision = 'rejected';
        }
        doc.draft = parseDraft(doc.draft, doc.manifest);
    });
}

export const importCandidateProjection = { name: 1, title: 1, coverArtId: 1, coverArtUrl: 1, creditRevision: 1, adminRevision: 1, albumId: 1, audioTrackIds: 1, releaseDate: 1, credits: 1, visibility: 1, lifecycleStatus: 1, uploadStatus: 1, publicationStatus: 1, mediaType: 1, s3Key: 1, mediaRepresentation: 1, mediaByteHash: 1, updatedAt: 1 };
const candidateProjection = importCandidateProjection;
/** Lifecycle touches may materialize legacy defaults; they do not change the reviewed content. */
export const importCandidateRevision = (doc: Record<string, any>): string => {
    const stable = (value: any): any => value instanceof ObjectId ? value.toHexString() : value instanceof Date ? value.toISOString() : Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, stable(value[key])])) : value;
    return digest(stable({ ...doc, lifecycleStatus: doc.lifecycleStatus ?? 'ready', visibility: doc.visibility ?? 'public' }));
};
function candidate(kind: ImportDuplicateCandidate['kind'], doc: Record<string, any>): ImportDuplicateCandidate {
    if (doc.visibility !== undefined && doc.visibility !== 'public' && doc.visibility !== 'hidden') return invalidImport();
    return { kind, id: doc._id.toHexString(), label: cleanText(kind === 'artist' ? doc.name : doc.title, 300), revision: importCandidateRevision(doc), albumId: typeof doc.albumId === 'string' && objectId(doc.albumId) ? doc.albumId : null, visibility: doc.visibility === 'hidden' ? 'hidden' : 'public', match: 'name', matchedSlotIds: [], automaticReuse: false };
}
const candidateCollection = { artist: 'artists', album: 'albums', track: 'audioTracks' };
const readyCandidate = (kind: ImportDuplicateCandidate['kind']) => kind === 'track' ? { $and: [readyAudioStorageFilter, { $or: [{ mediaType: 'audio' }, { mediaType: { $exists: false } }] }] } : kind === 'artist' ? readyArtistLifecycleFilter : readyAlbumLifecycleFilter;
export async function adminImportDuplicateCandidates(actor: string, id: string) {
    return withAdmin(actor, async session => {
        const doc = await collection().findOne({ _id: idValue(id) }, { session }); if (!doc) throw notFound(); const items: ImportDuplicateCandidate[] = [];
        const labels = { artist: [doc.draft.album.artistName], album: [doc.draft.album.title], track: doc.draft.tracks.map(track => track.title) };
        const hashes = new Set((doc.media?.assets ?? []).filter(asset => asset.state === 'ready' && doc.manifest.files.some(file => file.slotId === asset.slotId)).map(asset => asset.sha256));
        for (const kind of ['artist', 'album', 'track'] as const) {
            const values = [...new Set(labels[kind].filter(Boolean))].slice(0, 100); if (!values.length && (kind !== 'track' || !hashes.size)) continue;
            // Exact case-insensitive candidates only, bounded per kind; names are never unique identity keys.
            const patterns = values.map(value => new RegExp(`^${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'));
            const matches: Record<string, unknown>[] = [{ [kind === 'artist' ? 'name' : 'title']: { $in: patterns } }];
            if (kind === 'track' && hashes.size) matches.push({ 'mediaByteHash.value': { $in: [...hashes] } });
            const rows = await getDb()!.collection(candidateCollection[kind]).find({ $and: [readyCandidate(kind), { $or: matches }] }, { session, projection: candidateProjection }).sort({ _id: 1 }).limit(20).maxTimeMS(3_000).toArray();
            for (const row of rows) { try {
                const hash = row.mediaByteHash, representation = row.mediaRepresentation;
                const verified = kind === 'track' && typeof hash?.objectKey === 'string' && hash.objectKey.length > 0 && Number.isSafeInteger(hash.byteLength) && hash.byteLength > 0 && typeof hash.etag === 'string' && /^"[^"\r\n]{1,200}"$/.test(hash.etag) && (hash.versionId === null || (typeof hash.versionId === 'string' && hash.versionId.length > 0 && hash.versionId.length <= 1024)) && hash?.algorithm === 'sha256' && /^[a-f0-9]{64}$/.test(hash?.value) && hashes.has(hash.value) && hash.objectKey === row.s3Key && hash.objectKey === representation?.objectKey && hash.byteLength === representation?.byteLength && hash.etag === representation?.etag && hash.versionId === representation?.versionId;
                if (!verified && !values.some(value => value.toLocaleLowerCase() === String(kind === 'artist' ? row.name : row.title).toLocaleLowerCase())) continue;
                items.push({ ...candidate(kind, row), match: verified ? 'sha256' : 'name', matchedSlotIds: kind === 'track' ? doc.draft.tracks.filter(track => verified ? doc.media?.assets.some(asset => asset.slotId === track.slotId && asset.state === 'ready' && asset.sha256 === hash.value && asset.byteLength === hash.byteLength) : track.title.toLocaleLowerCase() === String(row.title).toLocaleLowerCase()).map(track => track.slotId) : [] });
            } catch { /* Malformed legacy metadata cannot become a selectable identity. */ } }
        }
        return { items };
    });
}
export function decideAdminImportDuplicates(actor: string, id: string, raw: unknown) {
    const body = mutation(raw, ['decisions']); if (!Array.isArray(body.decisions) || body.decisions.length > 102) return invalidImport();
    return mutate(actor, id, body, 'decisions', async (doc, session) => {
        const seen = new Set<string>(); const decisions: ImportDuplicateDecision[] = [];
        for (const rawDecision of body.decisions as unknown[]) {
            const decision = record(rawDecision); exact(decision, ['scope', 'slotId', 'action', 'candidateId', 'candidateRevision']);
            if (!['artist', 'album', 'track'].includes(decision.scope as string) || !['reuse', 'skip', 'create-distinct'].includes(decision.action as string)) return invalidImport();
            const scope = decision.scope as ImportDuplicateDecision['scope']; if (scope === 'track' ? typeof decision.slotId !== 'string' || !doc.manifest.files.some(file => file.slotId === decision.slotId) : decision.slotId !== null) return invalidImport();
            const key = `${scope}:${decision.slotId}`; if (seen.has(key)) return invalidImport(); seen.add(key);
            if (decision.action === 'reuse') {
                if (!objectId(decision.candidateId) || typeof decision.candidateRevision !== 'string' || !/^[a-f0-9]{64}$/.test(decision.candidateRevision)) return invalidImport();
                const target = await getDb()!.collection(candidateCollection[scope]).findOne({ _id: new ObjectId(decision.candidateId), ...readyCandidate(scope) }, { session, projection: candidateProjection });
                if (!target || candidate(scope, target).revision !== decision.candidateRevision) throw conflict('ADMIN_IMPORT_DUPLICATE_STALE');
                if (scope === 'track' && target.albumId) { const album = (body.decisions as Record<string, unknown>[]).find(d => d.scope === 'album' && d.action === 'reuse'); if (!album || album.candidateId !== target.albumId) throw conflict('ADMIN_IMPORT_TRACK_BELONGS_TO_ALBUM'); }
            } else if (decision.candidateId !== null || decision.candidateRevision !== null) return invalidImport();
            decisions.push(decision as unknown as ImportDuplicateDecision);
        }
        doc.decisions = decisions;
    });
}

/** Embedded tags are secondary untrusted evidence and have a separate prompt-size allowance. */
function boundedTags(tags: NonNullable<Analysis['tags']>, slots: string[]) { let bytes = 0; return tags.filter(item => slots.includes(item.slotId)).filter(item => { bytes += Buffer.byteLength(JSON.stringify(item)); return bytes <= 12_000; }); }

/** Serialize deployment-wide reservations before dispatch; uncertain or stopped reservations are not refunded. */
async function reserveDailyAnalysisAttempt(now: Date, session: ClientSession): Promise<boolean> {
    const slots = getDb()!.collection<{ _id: string; revision?: number; attempts?: number }>('adminImportAnalysisSlots');
    const gate = await slots.updateOne({ _id: 'admission' }, { $inc: { revision: 1 } }, { session });
    if (!gate.matchedCount) return false;
    const _id = `daily:${now.toISOString().slice(0, 10)}`;
    const budget = await slots.findOne({ _id }, { session });
    if ((budget?.attempts ?? 0) >= LIMITS.dailyAttempts) return false;
    await slots.updateOne({ _id }, { $inc: { attempts: 1 } }, { session, upsert: true });
    return true;
}

/** One durable chunk per tick. An expired in-flight lease is unknown, never an automatic paid retry. */
export async function runAdminImportWorkerOnce(provider: ImportAnalysisProvider = new OpenAiImportAnalysisProvider(), now = new Date(), signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted || !importEnabled() || !provider.configured()) return false;
    const worker = randomUUID();
    const claim = await collection().findOneAndUpdate({ $and: [{ $or: [{ 'analysis.state': { $in: ['queued', 'running'] } }, { 'analysis.state': 'cancelled', 'analysis.chunks.state': 'inflight' }] }, { $or: [{ 'analysis.leaseUntil': null }, { 'analysis.leaseUntil': { $lte: now } }] }] }, { $set: { 'analysis.leaseOwner': worker, 'analysis.leaseUntil': new Date(now.getTime() + LIMITS.leaseMs) } }, { sort: { createdAt: 1 }, returnDocument: 'after' });
    const claimed = claim.value; if (!claimed) return false;
    let input: AnalysisInput | undefined, attemptId = randomUUID();
    const session = getDatabaseClient().startSession();
    try {
        await session.withTransaction(async () => {
            input = undefined;
            const doc = await collection().findOne({ _id: claimed._id, 'analysis.leaseOwner': worker }, { session }); if (!doc) return;
            if (!isActive(doc) && !doc.analysis.chunks.some(chunk => chunk.state === 'inflight')) { await collection().updateOne({ _id: doc._id, 'analysis.leaseOwner': worker }, { $set: { 'analysis.leaseOwner': null, 'analysis.leaseUntil': null } }, { session }); return; }
            const analysis = doc.analysis; let issue: ImportIssue = null;
            if (analysis.chunks.some(chunk => chunk.state === 'inflight')) issue = 'providerOutcomeUnknown';
            else if (!analysis.grantExpiresAt || analysis.grantExpiresAt <= now) issue = 'grantExpired';
            else if (doc.attemptsUsed >= LIMITS.attempts) issue = 'budgetExhausted';
            else { try { await touchAdmin(analysis.actorId!, session); } catch (error) { if (!(error instanceof AdminImportError)) throw error; issue = 'permissionLost'; } }
            if (!issue && analysis.chunks.some(chunk => chunk.state === 'pending') && !await reserveDailyAnalysisAttempt(now, session)) issue = 'budgetExhausted';
            if (issue) { analysis.state = 'needsAttention'; analysis.issue = issue; for (const chunk of analysis.chunks) if (chunk.state === 'inflight') chunk.state = 'unknown'; analysis.leaseOwner = null; analysis.leaseUntil = null; }
            else {
                const chunk = analysis.chunks.find(chunk => chunk.state === 'pending');
                if (!chunk) { analysis.state = 'complete'; analysis.leaseOwner = null; analysis.leaseUntil = null; }
                else { analysis.state = 'running'; chunk.state = 'inflight'; chunk.attemptId = attemptId; chunk.startedAt = now; doc.attemptsUsed++; input = { generation: analysis.generation, chunk: chunk.index, manifest: { rootLabel: doc.manifest.rootLabel, files: chunk.album ? doc.manifest.files : doc.manifest.files.filter(file => chunk.slots.includes(file.slotId)) }, baseline: { album: analysis.baseline!.album, tracks: chunk.album ? [] : analysis.baseline!.tracks.filter(track => chunk.slots.includes(track.slotId)) }, slots: chunk.slots, album: chunk.album, tags: boundedTags(analysis.tags ?? [], chunk.album ? doc.manifest.files.slice(0, 10).map(file => file.slotId) : chunk.slots) }; }
            }
            doc.revision++; doc.updatedAt = now; await collection().replaceOne({ _id: doc._id, revision: doc.revision - 1, 'analysis.leaseOwner': worker }, doc, { session });
        }, { writeConcern: { w: 'majority' } });
    } finally { await session.endSession(); }
    if (!input) return true;
    if (signal?.aborted) { await collection().updateOne({ _id: claimed._id, 'analysis.leaseOwner': worker, 'analysis.chunks': { $elemMatch: { attemptId, state: 'inflight' } } }, { $set: { 'analysis.chunks.$.state': 'pending', 'analysis.chunks.$.attemptId': null, 'analysis.chunks.$.startedAt': null, 'analysis.state': 'queued', 'analysis.leaseOwner': null, 'analysis.leaseUntil': null }, $inc: { attemptsUsed: -1, revision: 1 } }); return true; }
    const dispatchedInput = input as AnalysisInput; let suggestions: Awaited<ReturnType<ImportAnalysisProvider['analyze']>> = [], failure: ImportIssue = null;
    try { suggestions = await provider.analyze(dispatchedInput, signal); }
    catch (error) { failure = error instanceof ImportProviderError ? error.issue : 'providerOutcomeUnknown'; }
    const finish = getDatabaseClient().startSession();
    try {
        await finish.withTransaction(async () => {
            const doc = await collection().findOne({ _id: claimed._id, 'analysis.leaseOwner': worker, 'analysis.generation': dispatchedInput.generation }, { session: finish }); if (!doc) return;
            const chunk = doc.analysis.chunks.find(chunk => chunk.attemptId === attemptId && chunk.state === 'inflight'); if (!chunk) return;
            let issue: ImportIssue = failure; try { await touchAdmin(doc.analysis.actorId!, finish); } catch (error) { if (!(error instanceof AdminImportError)) throw error; issue = 'permissionLost'; }
            chunk.completedAt = new Date(); chunk.state = issue ? (issue === 'providerOutcomeUnknown' ? 'unknown' : 'failed') : 'complete';
            if (!issue) doc.suggestions.push(...suggestions.map((suggestion, index) => ({ ...suggestion, id: digest({ importId: doc._id.toHexString(), generation: dispatchedInput.generation, chunk: chunk.index, index }).slice(0, 24), generation: dispatchedInput.generation, decision: 'pending' as const })));
            if (doc.analysis.state !== 'cancelled') { doc.analysis.state = issue ? 'needsAttention' : doc.analysis.chunks.every(chunk => chunk.state === 'complete') ? 'complete' : 'queued'; doc.analysis.issue = issue; }
            else if (issue) doc.analysis.issue = issue;
            doc.analysis.leaseOwner = null; doc.analysis.leaseUntil = null; doc.revision++; doc.updatedAt = new Date();
            await collection().replaceOne({ _id: doc._id, revision: doc.revision - 1, 'analysis.leaseOwner': worker }, doc, { session: finish });
        }, { writeConcern: { w: 'majority' } });
    } finally { await finish.endSession(); }
    return true;
}

/** Process-independent persisted queue; closing HTTP observers never cancels admitted work. */
export function startAdminImportWorker(provider: ImportAnalysisProvider = new OpenAiImportAnalysisProvider(), intervalMs = 2_000, track?: AdminWorkTracker): () => Promise<void> {
    return startAdminWorker(signal => runAdminImportWorkerOnce(provider, new Date(), signal), intervalMs, track);
}
