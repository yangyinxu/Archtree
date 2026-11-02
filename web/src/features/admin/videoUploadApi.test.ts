import { ApiError } from '../../api/client';
import { mergeVideoDraft, validVideoSelection } from './AdminVideoUploadPage';
import { videoUploadRequest, videoProjectSchema } from './videoUploadApi';
import { videoTransferFailure } from './useVideoTransfer';
import { videoProject, videoOperationId } from './videoUploadFixtures.testSupport';
import { videoProcessingIssue, videoPublicationNeedsReview } from './videoFailure';

test('original MP4 MOV and M4V admission depends on bounded bytes rather than MIME or local codec support', () => {
  for (const name of ['HEVC.MOV', 'HEVC.mp4', 'source.m4v']) expect(validVideoSelection({ name, size: 512 }, 512)).toBe(true);
  for (const file of [{ name: 'video.txt', size: 1 }, { name: 'video.mov', size: 513 }, { name: 'video.mov', size: 0 }]) expect(validVideoSelection(file, 512)).toBe(false);
});

test('the multipart operation preserves original bytes and an immutable retry identity without a conversion target', () => {
  const file = new File(['original HEVC'], 'original.MOV', { type: 'video/quicktime' });
  const first = videoUploadRequest(file, file.name, videoOperationId, 7), retry = videoUploadRequest(file, file.name, videoOperationId, 7);
  expect(first.headers).toEqual(retry.headers);
  expect(first.headers['Idempotency-Key']).toBe(videoOperationId);
  expect(first.headers['If-Match']).toBe('7');
  expect(first.body.size).toBe(retry.body.size);
  expect(first.body.size).toBeGreaterThan(file.size);
  expect(() => videoUploadRequest(file, file.name, 'new-intent', 7)).toThrow();
});

test('network loss and busy admissions keep their original transfer intent, while definite refusals do not', () => {
  expect(videoTransferFailure(new Error('network')).unknown).toBe(true);
  expect(videoTransferFailure(new ApiError('server', 'http', 503)).unknown).toBe(true);
  expect(videoTransferFailure(new ApiError('busy', 'http', 409, 'ADMIN_VIDEO_SOURCE_BUSY')).unknown).toBe(true);
  for (const code of ['ADMIN_VIDEO_RECONCILE_REQUIRED', 'ADMIN_VIDEO_SOURCE_EXISTS', 'ADMIN_VIDEO_COVER_RECONCILE_REQUIRED']) expect(videoTransferFailure(new ApiError('pending', 'http', 409, code)).unknown).toBe(true);
  expect(videoTransferFailure(new ApiError('invalid', 'http', 413))).toEqual({ error: 'file', unknown: false });
  expect(videoTransferFailure(new ApiError('changed', 'http', 409, 'ADMIN_VIDEO_STALE_REVISION'))).toEqual({ error: 'conflict', unknown: false });
});

test('private cover sources cannot point outside their exact Video project', () => {
  const base = videoProject();
  const cover = { id: 'cccccccccccccccccccccccc', name: 'frame.jpg', source: 'frame' as const, state: 'ready' as const, operationId: videoOperationId, previewUrl: `/api/admin/v1/video-projects/${base.id}/covers/cccccccccccccccccccccccc/preview?viewer=synthetic` };
  expect(videoProjectSchema.safeParse({ ...base, covers: [cover] }).success).toBe(true);
  expect(videoProjectSchema.safeParse({ ...base, covers: [{ ...cover, previewUrl: 'https://external.invalid/private.jpg' }] }).success).toBe(false);
  expect(videoProjectSchema.safeParse({ ...base, covers: [{ ...cover, previewUrl: '/api/admin/v1/video-projects/other/covers/cover-1/preview' }] }).success).toBe(false);
});

test('server refreshes update untouched fields while preserving edited ownership and title', () => {
  const initial = videoProject().draft;
  const saved = { ...initial, coverChoice: 'automatic-cover' };
  const result = mergeVideoDraft({ saved: initial, draft: { ...initial, title: 'My title', attribution: 'unknown' } }, saved);
  expect(result.draft).toMatchObject({ title: 'My title', attribution: 'unknown', coverChoice: 'automatic-cover' });
  expect(result.saved).toEqual(saved);
});

test('known processing blockers and expired approvals choose fixed safe copy and recovery', () => {
  for (const issue of ['invalid_source', 'unsupported_layout']) expect(videoProcessingIssue(issue)).toBe('invalid');
  expect(videoProcessingIssue('processor_unavailable')).toBe('unavailable');
  expect(videoProcessingIssue('processor_busy')).toBe('busy');
  expect(videoProcessingIssue('processing_timeout')).toBe('timeout');
  expect(videoProcessingIssue('a private diagnostic must never render')).toBe('retry');
  for (const issue of ['reference_changed', 'approval_expired']) expect(videoPublicationNeedsReview(issue)).toBe(true);
  expect(videoPublicationNeedsReview('storage_unknown')).toBe(false);
});
