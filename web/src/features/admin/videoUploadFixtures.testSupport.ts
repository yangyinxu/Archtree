import type { VideoProject } from './videoUploadApi';

export const videoViewer = 'aaaaaaaaaaaaaaaaaaaaaaaa';
export const videoProjectId = 'bbbbbbbbbbbbbbbbbbbbbbbb';
export const videoOperationId = '10000000-0000-4000-8000-000000000001';

/** A synthetic ready source is private until the separate frozen publication request succeeds. */
export function videoProject(): VideoProject {
  return {
    id: videoProjectId, revision: 3, createdAt: '2026-11-01T12:00:00.000Z', updatedAt: '2026-11-01T12:00:00.000Z', stage: 'review',
    draft: { title: 'Synthetic Video', attribution: 'self', publicName: '', subjectType: 'artist', subjectId: null, albumId: null, visibility: 'public', coverChoice: 'automatic' },
    ingress: { source: null, cover: null },
    source: { filename: 'synthetic-original.MOV', byteLength: 12, status: 'ready', operationId: videoOperationId },
    processing: { state: 'ready', plan: 'remux', step: null, progress: 100, issue: null, facts: { plan: 'remux', durationSeconds: 2, width: 1280, height: 720, videoCodec: 'hevc', audioCodec: 'aac' } },
    frame: { state: 'idle', issue: null }, covers: [], selectedCoverId: null,
    publication: { state: 'idle', operationId: null, mediaTrackId: null, coverUrl: null, issue: null, cleanupPending: false },
    approvalDigest: 'a'.repeat(64), references: { subject: null, album: null }
  };
}
