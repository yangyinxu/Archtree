import type { ImportArtistEntry, ImportDetail, ImportDraftV2, ImportLabelEntry } from './adminApi';
import type { ImportCandidate } from './importIdentity';
export const viewer = 'aaaaaaaaaaaaaaaaaaaaaaaa';
export const projectId = 'bbbbbbbbbbbbbbbbbbbbbbbb';
export const slotId = '10000000-0000-4000-8000-000000000001';
export const slotTwo = '10000000-0000-4000-8000-000000000002';
export const capabilities = { schemaVersion: 1, admin: true, albumImports: { enabled: true, analysisAvailable: true, model: 'gpt-6-luna', maxFiles: 100 }, catalog: { editing: false, visibility: false }, metadataLookup: { available: false } };
export const session = { user: { id: viewer, displayName: 'Synthetic Admin', avatarRevision: 0, avatar: null, email: 'synthetic@example.invalid', role: 'admin', emailVerified: true } };
export function detail(): ImportDetail {
  return {
    id: projectId, revision: 1, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', startedByMe: true,
    manifest: { rootLabel: 'Synthetic Album', files: [{ slotId, filename: '01 First.mp3', relativePath: 'Synthetic Album/01 First.mp3', byteLength: 100 }, { slotId: slotTwo, filename: '02 Second.mp3', relativePath: 'Synthetic Album/02 Second.mp3', byteLength: 200 }] },
    draft: { album: { title: '', artists: [], label: null, releaseDate: null, visibility: 'public' }, tracks: [{ slotId, title: '', discNumber: null, trackNumber: null }, { slotId: slotTwo, title: '', discNumber: null, trackNumber: null }] },
    analysis: { state: 'complete', generation: 1, operationId: '20000000-0000-4000-8000-000000000001', completedChunks: 2, totalChunks: 2, attemptsUsed: 2, maxAttempts: 22, issue: null },
    assets: [], selectedCoverSlotId: null, coverChoice: 'explicit', published: null, publicationRecovery: null, suggestions: [
      { id: 'cccccccccccccccccccccccc', generation: 1, scope: 'album', slotId: null, field: 'title', baseline: '', value: 'Suggested Album', source: 'folder', evidence: 'Synthetic Album', decision: 'pending' },
      { id: 'dddddddddddddddddddddddd', generation: 1, scope: 'track', slotId, field: 'trackNumber', baseline: null, value: 1, source: 'filename', evidence: '01 First.mp3', decision: 'pending' }
    ], decisions: [], upload: { ready: 0, total: 2, available: false }, publication: 'notAvailable', capabilities: { analysis: true, upload: false, publish: false }, receipts: [],
    approvalDigest: 'e'.repeat(64), valueRevision: 0, automaticPaths: [], lookupPaths: [], possibleLabelEntryKeys: []
  };
}
/** One synthetic Artist entry, primary by default; a fixed key keeps saved and edited drafts comparable. */
export const artistEntry = (name: string, key = '30000000-0000-4000-8000-000000000001', role: ImportArtistEntry['role'] = 'primary'): ImportArtistEntry => ({ key, name, role, joinPhrase: null, musicBrainzId: null });
/** The fixed key of the nth synthetic Artist entry; entryKey(1) is artistEntry's default key. */
export const entryKey = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
/** A synthetic label Organization without a MusicBrainz ID. */
export const labelEntry = (name: string): ImportLabelEntry => ({ name, musicBrainzId: null });
/** Applies a field-patch body to a mocked saved draft the way the server writes it: each path's value replaces it whole. */
export function applyDraftChanges(draft: ImportDraftV2, changes: { path: string; value: unknown }[]): ImportDraftV2 {
  const next = structuredClone(draft);
  for (const { path, value } of changes) {
    const [scope, first, second] = path.split('.');
    const holder = (scope === 'album' ? next.album : next.tracks.find(track => track.slotId === first)) as Record<string, unknown>;
    holder[scope === 'album' ? first : second] = value;
  }
  return next;
}
/**
 * A synthetic import project endpoint: a PATCH records its body, applies its changes as the server writes them and confirms a
 * new revision; the duplicate candidates read lists `candidates` (complete member matches); any other request reads the current project. `set` replaces
 * the project, as another administrator's save would.
 */
export function fieldSaveEndpoint(initial: ImportDetail, candidates: ImportCandidate[] = []) {
  let item = initial; const writes: Record<string, any>[] = [];
  return {
    writes, current: () => item, set: (next: ImportDetail) => { item = next; },
    fetch: async (path: string, init?: RequestInit) => {
      if (path.endsWith('/duplicate-candidates')) return json({ items: candidates, memberMatchesComplete: true });
      if (init?.method !== 'PATCH') return json({ item, receipt: null });
      const body = JSON.parse(String(init.body)); writes.push(body);
      item = { ...item, revision: item.revision + 1, draft: applyDraftChanges(item.draft, body.changes) };
      return json({ item, receipt: { operationId: body.operationId, kind: 'edit', revision: item.revision } });
    }
  };
}
export const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', 'X-Finitude-Account-Viewer': viewer } });
export function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
/**
 * The summary read (GET …/lookup) of a project before any lookup on a server that can run it: nothing to wait for, no identity
 * row to answer, some budget left, and, as the server lists them, each pending suggestion of `item` with its tick state (here
 * unticked; without `item`, none).
 */
export const lookupResponse = (overrides: Record<string, unknown> = {}, item?: Pick<ImportDetail, 'suggestions'>) => ({ lookup: null, revision: 0, valueRevision: 0,
  summary: { append: false, waiting: { uploads: false, lookup: false, cover: false, analysis: false }, placeholderOnly: false,
    luna: (item?.suggestions ?? []).filter(suggestion => suggestion.decision === 'pending').map(suggestion => ({ id: suggestion.id, tick: 'unticked' })),
    analysis: { runs: 1, attempts: 20, daily: 200 }, lookupAvailable: true, identityAnswers: 0 }, ...overrides });
/** A fetch stub that answers the summary read with `response` and passes every other request to `fetch`, which never sees it. */
export function withLookup(fetch: (path: string, init: RequestInit) => unknown, response: () => unknown = () => lookupResponse()) {
  return (path: string, init?: RequestInit) => /\/lookup$/.test(String(path)) && (!init?.method || init.method === 'GET') ? json(response()) : fetch(path, init as RequestInit);
}
