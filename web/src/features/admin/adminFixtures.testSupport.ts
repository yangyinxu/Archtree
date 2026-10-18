import type { ImportDetail } from './adminApi';
export const viewer = 'aaaaaaaaaaaaaaaaaaaaaaaa';
export const projectId = 'bbbbbbbbbbbbbbbbbbbbbbbb';
export const slotId = '10000000-0000-4000-8000-000000000001';
export const slotTwo = '10000000-0000-4000-8000-000000000002';
export const capabilities = { schemaVersion: 1, admin: true, albumImports: { enabled: true, analysisAvailable: true, model: 'gpt-6-luna', maxFiles: 100 }, catalog: { editing: false, visibility: false } };
export const session = { user: { id: viewer, displayName: 'Synthetic Admin', avatarRevision: 0, avatar: null, email: 'synthetic@example.invalid', role: 'admin', emailVerified: true } };
export function detail(): ImportDetail {
  return {
    id: projectId, revision: 1, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', startedByMe: true,
    manifest: { rootLabel: 'Synthetic Album', files: [{ slotId, filename: '01 First.mp3', relativePath: 'Synthetic Album/01 First.mp3', byteLength: 100 }, { slotId: slotTwo, filename: '02 Second.mp3', relativePath: 'Synthetic Album/02 Second.mp3', byteLength: 200 }] },
    draft: { album: { title: '', artistName: '', releaseDate: null, visibility: 'public' }, tracks: [{ slotId, title: '', trackNumber: null }, { slotId: slotTwo, title: '', trackNumber: null }] },
    analysis: { state: 'complete', generation: 1, operationId: '20000000-0000-4000-8000-000000000001', completedChunks: 2, totalChunks: 2, attemptsUsed: 2, maxAttempts: 22, issue: null },
    assets: [], selectedCoverSlotId: null, published: null, publicationRecovery: null, suggestions: [
      { id: 'cccccccccccccccccccccccc', generation: 1, scope: 'album', slotId: null, field: 'title', baseline: '', value: 'Suggested Album', source: 'folder', evidence: 'Synthetic Album', decision: 'pending' },
      { id: 'dddddddddddddddddddddddd', generation: 1, scope: 'track', slotId, field: 'trackNumber', baseline: null, value: 1, source: 'filename', evidence: '01 First.mp3', decision: 'pending' }
    ], decisions: [], upload: { ready: 0, total: 2, available: false }, publication: 'notAvailable', capabilities: { analysis: true, upload: false, publish: false }, receipts: []
  };
}
export const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', 'X-Finitude-Account-Viewer': viewer } });
export function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
