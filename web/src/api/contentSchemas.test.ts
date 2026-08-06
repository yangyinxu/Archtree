import {
  albumSummarySchema,
  contentSummarySchema,
  homeSectionSchema,
  libraryPageSchema,
  listenerHomeSchema
} from './contentSchemas';

const album = {
  contentType: 'album' as const,
  id: 'album-1',
  title: 'Still Water',
  artworkUrl: '/content/images/album-1',
  artistNames: ['Finitude Ensemble'],
  releaseDate: { year: 2026, month: 8, day: 2 }
};

const audioTrack = {
  contentType: 'audioTrack' as const,
  id: 'track-1',
  title: 'First Light',
  artworkUrl: '',
  artistNames: ['Finitude Ensemble'],
  albumId: 'album-1',
  albumTitle: 'Still Water',
  duration: '3:48',
  streamUrl: '/content/audioTrack/stream/track-1'
};

test('accepts the discriminated listener content contract', () => {
  expect(contentSummarySchema.parse(album)).toEqual(album);
  expect(contentSummarySchema.parse(audioTrack)).toEqual(audioTrack);
  expect(listenerHomeSchema.parse({
    title: 'Home',
    sections: [{ id: 'quiet', title: 'Quiet hours', presentation: 'carousel', items: [album, audioTrack] }]
  }).sections[0].items).toHaveLength(2);
});

test('rejects internal fields and artists inside Home music sections', () => {
  expect(albumSummarySchema.safeParse({ ...album, createdBy: 'private-owner' }).success).toBe(false);
  expect(contentSummarySchema.safeParse({ ...audioTrack, s3Key: 'private-storage-key' }).success).toBe(false);
  expect(homeSectionSchema.safeParse({
    id: 'invalid',
    title: 'Invalid section',
    presentation: 'grid',
    items: [{
      contentType: 'artist',
      id: 'artist-1',
      name: 'Artist',
      bio: '',
      artworkUrl: ''
    }]
  }).success).toBe(false);
});

test('sanitizes unknown fields from the legacy nested Library response', () => {
  const parsed = libraryPageSchema.parse({
    items: [
      {
        contentType: 'album',
        contentId: 'album-1',
        savedAt: '2026-08-02T10:00:00.000Z',
        lastPlayedAt: null,
        lastActivityAt: '2026-08-02T10:00:00.000Z',
        creator: 'Finitude Ensemble',
        databaseOnly: 'remove-me',
        album: {
          _id: 'album-1',
          title: 'Still Water',
          coverArtUrl: '/content/images/album-1',
          releaseDate: { year: 2026 },
          createdBy: 'private-owner',
          audioTrackIds: ['track-1']
        }
      },
      {
        contentType: 'audioTrack',
        contentId: 'track-1',
        savedAt: '2026-08-01T10:00:00.000Z',
        lastPlayedAt: '2026-08-02T09:00:00.000Z',
        lastActivityAt: '2026-08-02T09:00:00.000Z',
        creator: null,
        audioTrack: {
          _id: 'track-1',
          title: 'First Light',
          displayCoverArtUrl: '/content/images/album-1',
          albumId: 'album-1',
          duration: '3:48',
          available: true,
          streamUrl: '/content/audioTrack/stream/track-1',
          s3Key: 'private-storage-key',
          uploadError: 'private-lifecycle-state'
        }
      }
    ],
    nextCursor: null,
    internalPageState: true
  });

  expect(parsed).toEqual({
    items: [
      {
        contentType: 'album',
        contentId: 'album-1',
        savedAt: '2026-08-02T10:00:00.000Z',
        lastPlayedAt: null,
        lastActivityAt: '2026-08-02T10:00:00.000Z',
        creator: 'Finitude Ensemble',
        album: {
          _id: 'album-1',
          title: 'Still Water',
          coverArtUrl: '/content/images/album-1',
          releaseDate: { year: 2026 }
        }
      },
      {
        contentType: 'audioTrack',
        contentId: 'track-1',
        savedAt: '2026-08-01T10:00:00.000Z',
        lastPlayedAt: '2026-08-02T09:00:00.000Z',
        lastActivityAt: '2026-08-02T09:00:00.000Z',
        creator: null,
        audioTrack: {
          _id: 'track-1',
          title: 'First Light',
          displayCoverArtUrl: '/content/images/album-1',
          coverArtUrl: '',
          albumId: 'album-1',
          duration: '3:48',
          available: true,
          streamUrl: '/content/audioTrack/stream/track-1'
        }
      }
    ],
    nextCursor: null
  });
});
