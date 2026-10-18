/** Allowlisted admin-only naming, review, asset and publication contract. */
export const ADMIN_IMPORT_LIMITS = Object.freeze({ files: 100, page: 25, receipts: 256, publications: 16, generations: 2, tracksPerChunk: 10, attempts: 22, dailyAttempts: 220, outputTokens: 4000, inputBytes: 48_000, responseBytes: 256_000, grantMs: 24 * 60 * 60 * 1000, leaseMs: 120_000, embeddedCovers: 16, uploadSettleMs: 180_000 });
export type ImportDate = { year: number; month: number | null; day: number | null };
export type ImportManifest = { rootLabel: string; files: { slotId: string; filename: string; relativePath: string; byteLength: number | null }[] };
export type ImportDraft = { album: { title: string; artistName: string; releaseDate: ImportDate | null; visibility: 'public' | 'hidden' }; tracks: { slotId: string; title: string; trackNumber: number | null }[] };
export type ImportField = 'title' | 'artistName' | 'releaseDate' | 'trackNumber';
export type ImportValue = string | number | ImportDate | null;
export type ImportSuggestion = { id: string; generation: number; scope: 'album' | 'track'; slotId: string | null; field: ImportField; baseline: ImportValue; value: ImportValue; source: 'filename' | 'folder' | 'context'; evidence: string; decision: 'pending' | 'accepted' | 'rejected' };
export type ImportAnalysisState = 'idle' | 'queued' | 'running' | 'complete' | 'cancelled' | 'needsAttention';
export type ImportIssue = 'providerUnavailable' | 'providerRejected' | 'providerInvalidResponse' | 'providerOutcomeUnknown' | 'permissionLost' | 'grantExpired' | 'budgetExhausted' | null;
export type ImportReceipt = { operationId: string; kind: 'create' | 'edit' | 'analyze' | 'adopt' | 'decisions' | 'cancel-analysis' | 'upload' | 'publish' | 'cleanup' | 'select-cover' | 'cancel-publication'; revision: number };
export type ImportEmbeddedTags = { title: string | null; album: string | null; artists: string[]; year: number | null; trackNumber: number | null };
export type ImportDuplicateCandidate = { kind: 'artist' | 'album' | 'track'; id: string; label: string; revision: string; albumId: string | null; visibility: 'public' | 'hidden'; match: 'name' | 'sha256'; matchedSlotIds: string[]; automaticReuse: false };
export type ImportDuplicateDecision = { scope: 'artist' | 'album' | 'track'; slotId: string | null; action: 'reuse' | 'skip' | 'create-distinct'; candidateId: string | null; candidateRevision: string | null };
export type AdminImportDetail = {
    id: string; revision: number; createdAt: string; updatedAt: string; startedByMe: boolean;
    manifest: ImportManifest; draft: ImportDraft;
    analysis: { state: ImportAnalysisState; generation: number; operationId: string | null; completedChunks: number; totalChunks: number; attemptsUsed: number; maxAttempts: number; issue: ImportIssue };
    suggestions: ImportSuggestion[]; decisions: ImportDuplicateDecision[];
    upload: { ready: number; total: number; available: boolean }; publication: 'notAvailable' | 'notStarted' | 'preparing' | 'needsAttention' | 'complete' | 'cancelled';
    publicationRecovery: { operationId: string; cleanupPending: boolean; startedByMe: boolean } | null;
    assets: { slotId: string; state: 'pending' | 'ready' | 'failed' | 'unknown' | 'deleting' | 'cleanupFailed' | 'deleted'; byteLength: number; sha256: string; contentType: string; tags: ImportEmbeddedTags | null; recovery: { operationId: string; expectedRevision: number; kind: 'upload' | 'cleanup'; startedByMe: boolean } }[];
    selectedCoverSlotId: string | null;
    published: { albumId: string; artistId: string; trackIds: string[] } | null;
    capabilities: { analysis: boolean; upload: boolean; publish: boolean }; receipts: ImportReceipt[];
};
export type AdminImportResponse = { item: AdminImportDetail; receipt: ImportReceipt | null };
export type ImportWorkbenchFilter = 'all' | 'analyzing' | 'awaitingReview' | 'needsAttention' | 'completed';
export type ImportWorkbenchItem = Pick<AdminImportDetail, 'id' | 'revision' | 'createdAt' | 'updatedAt' | 'startedByMe' | 'analysis' | 'upload' | 'publication'> & { title: string; rootLabel: string; artistName: string; visibility: 'public' | 'hidden'; pendingSuggestions: number };
export type ImportWorkbenchResponse = { items: ImportWorkbenchItem[]; counts: Record<ImportWorkbenchFilter, number>; nextCursor: string | null };

/** Bounded codes are suitable for localization; provider/DB exception text is never returned. */
export class AdminImportError extends Error {
    constructor(public readonly status: number, public readonly code: string) { super(code); this.name = 'AdminImportError'; }
}
export const invalidImport = (): never => { throw new AdminImportError(400, 'ADMIN_IMPORT_INVALID_INPUT'); };
export const importEnabled = () => process.env.FINITUDE_ADMIN_IMPORTS_ENABLED === 'true';
export const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export const objectId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{24}$/.test(value);
export const record = (value: unknown): Record<string, unknown> => { if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidImport(); return value as Record<string, unknown>; };
export const exact = (value: Record<string, unknown>, keys: string[]) => { if (Object.keys(value).some(key => !keys.includes(key))) invalidImport(); };
export const cleanText = (value: unknown, max: number, empty = false): string => {
    if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f-\u009f]/u.test(value) || /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(value)) return invalidImport();
    const text = value.normalize('NFC').trim(); if (!empty && !text) return invalidImport(); return text;
};
export function parseImportDate(value: unknown): ImportDate | null {
    if (value === null) return null;
    const date = record(value); exact(date, ['year', 'month', 'day']);
    const { year, month, day } = date;
    if (!Number.isInteger(year) || (year as number) < 1 || (year as number) > 9999 || (month !== null && (!Number.isInteger(month) || (month as number) < 1 || (month as number) > 12)) || (day !== null && (!Number.isInteger(day) || month === null || (day as number) < 1 || (day as number) > 31))) return invalidImport();
    if (day !== null) { const leap = (year as number) % 4 === 0 && ((year as number) % 100 !== 0 || (year as number) % 400 === 0); if ((day as number) > [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][(month as number) - 1]) return invalidImport(); }
    return { year: year as number, month: month as number | null, day: day as number | null };
}
/** An empty rootLabel is valid only for files chosen without a folder. */
export function parseManifest(value: unknown): ImportManifest {
    const input = record(value); exact(input, ['rootLabel', 'files']); const rootLabel = cleanText(input.rootLabel, 200, true);
    if (/[\\/]/.test(rootLabel) || !Array.isArray(input.files) || input.files.length < 1 || input.files.length > ADMIN_IMPORT_LIMITS.files) return invalidImport();
    const ids = new Set<string>(), paths = new Set<string>();
    const files = input.files.map(raw => {
        const file = record(raw); exact(file, ['slotId', 'filename', 'relativePath', 'byteLength']);
        if (!uuid(file.slotId)) return invalidImport(); const slotId = file.slotId.toLowerCase();
        const filename = cleanText(file.filename, 255), relativePath = cleanText(file.relativePath, 1024);
        const parts = relativePath.split('/');
        if (/[\\/:]/.test(filename) || /[\\:]/.test(relativePath) || parts.length > 16 || parts.some(part => !part || part === '.' || part === '..' || part.trim() !== part) || parts[parts.length - 1] !== filename || ids.has(slotId) || paths.has(relativePath)) return invalidImport();
        if (file.byteLength !== null && (!Number.isSafeInteger(file.byteLength) || (file.byteLength as number) < 1 || (file.byteLength as number) > 8 * 1024 ** 3)) return invalidImport();
        ids.add(slotId); paths.add(relativePath); return { slotId, filename, relativePath, byteLength: file.byteLength as number | null };
    });
    if (!rootLabel && files.some(file => file.relativePath.includes('/'))) return invalidImport();
    const result = { rootLabel, files }; if (Buffer.byteLength(JSON.stringify(result)) > 24_000) return invalidImport(); return result;
}
export function parseDraft(value: unknown, manifest: ImportManifest): ImportDraft {
    const input = record(value); exact(input, ['album', 'tracks']); const album = record(input.album); exact(album, ['title', 'artistName', 'releaseDate', 'visibility']);
    if (!['public', 'hidden'].includes(album.visibility as string) || !Array.isArray(input.tracks) || input.tracks.length !== manifest.files.length) return invalidImport();
    const seen = new Set<string>();
    const tracks = input.tracks.map(raw => {
        const track = record(raw); exact(track, ['slotId', 'title', 'trackNumber']);
        if (typeof track.slotId !== 'string' || !manifest.files.some(file => file.slotId === track.slotId) || seen.has(track.slotId)) return invalidImport();
        if (track.trackNumber !== null && (!Number.isInteger(track.trackNumber) || (track.trackNumber as number) < 1 || (track.trackNumber as number) > 9999)) return invalidImport();
        seen.add(track.slotId); return { slotId: track.slotId, title: cleanText(track.title, 300, true), trackNumber: track.trackNumber as number | null };
    });
    const result = { album: { title: cleanText(album.title, 300, true), artistName: cleanText(album.artistName, 200, true), releaseDate: parseImportDate(album.releaseDate), visibility: album.visibility as 'public' | 'hidden' }, tracks };
    if (Buffer.byteLength(JSON.stringify(result)) > 48_000) return invalidImport(); return result;
}
export const defaultDraft = (manifest: ImportManifest): ImportDraft => ({ album: { title: '', artistName: '', releaseDate: null, visibility: 'hidden' }, tracks: manifest.files.map(file => ({ slotId: file.slotId, title: '', trackNumber: null })) });
