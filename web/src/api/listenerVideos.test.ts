import { listenerVideosSchema } from './listenerVideos';

const video = {
  contentType: 'audioTrack', id: 'video-1', title: 'First Light', artworkUrl: '',
  artistNames: [], albumId: null, albumTitle: null, duration: '0:15', mediaType: 'video',
  streamUrl: '/content/mediaTrack/stream/video-1'
};

test('Videos strips additive fields before returning public summaries to the cache', () => {
  expect(listenerVideosSchema.parse({
    items: [{ ...video, s3Key: 'private-storage-key', createdBy: 'private-owner' }],
    nextCursor: null, internalState: true
  })).toEqual({ items: [video], nextCursor: null, defaultView: 'grid' });
});

test('Videos accepts the configured default display and rejects unsupported defaults', () => {
  expect(listenerVideosSchema.parse({ items: [video], nextCursor: null, defaultView: 'immersive' }).defaultView).toBe('immersive');
  expect(listenerVideosSchema.safeParse({ items: [video], nextCursor: null, defaultView: 'carousel' }).success).toBe(false);
});

test('Videos rejects Audio, repeated members, oversized pages, and an empty continuation', () => {
  for (const items of [
    [{ ...video, mediaType: 'audio' }],
    [{ ...video, mediaType: undefined }],
    [video, video],
    Array.from({ length: 49 }, (_, index) => ({ ...video, id: `video-${index}` }))
  ]) expect(listenerVideosSchema.safeParse({ items, nextCursor: null }).success).toBe(false);
  expect(listenerVideosSchema.safeParse({ items: [], nextCursor: 'continue' }).success).toBe(false);
  expect(listenerVideosSchema.safeParse({ items: [video], nextCursor: 'x'.repeat(2_049) }).success).toBe(false);
});
