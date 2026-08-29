import {
  albumSummarySchema,
  contentByline,
  contentSummarySchema,
  homeSectionSchema,
  libraryPageSchema,
  listenerHomeSchema,
  listenerOrganizationSchema
} from './contentSchemas';
import {
  collectionPageSummaries,
  listenerCollectionPageSchema
} from './collectionSchemas';

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
  mediaType: 'video',
  streamUrl: '/content/mediaTrack/stream/track-1'
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

test('validates and rejoins a strict Grid/List page in configured order', () => {
  const laterTrack = { ...audioTrack, id: 'track-2', title: 'Night Window' };
  const page = listenerCollectionPageSchema.parse({
    pageItem: {
      id: 'page-item-1',
      pageSlug: 'home',
      title: 'Focus',
      presentation: 'list',
      mode: 'manual',
      contentType: 'audioTrack'
    },
    items: [
      { contentType: 'audioTrack', contentId: laterTrack.id, order: 4 },
      { contentType: 'audioTrack', contentId: audioTrack.id, order: 8 }
    ],
    included: {
      albums: [],
      audioTracks: [audioTrack, laterTrack]
    },
    limit: 20,
    nextCursor: 'opaque-cursor'
  });

  expect(collectionPageSummaries(page).map((item) => item.id)).toEqual([
    laterTrack.id,
    audioTrack.id
  ]);
});

test('rejects incomplete, out-of-order, and private Grid/List page projections', () => {
  const basePage = {
    pageItem: {
      id: 'page-item-1',
      pageSlug: 'home',
      title: 'Albums',
      presentation: 'grid',
      mode: 'manual',
      contentType: 'album'
    },
    items: [{ contentType: 'album', contentId: album.id, order: 0 }],
    included: { albums: [album], audioTracks: [] },
    limit: 20,
    nextCursor: null
  } as const;

  expect(listenerCollectionPageSchema.safeParse({
    ...basePage,
    included: { albums: [], audioTracks: [] }
  }).success).toBe(false);
  expect(listenerCollectionPageSchema.safeParse({
    ...basePage,
    items: [
      { contentType: 'album', contentId: album.id, order: 1 },
      { contentType: 'album', contentId: album.id, order: 0 }
    ],
    included: { albums: [album, album], audioTracks: [] }
  }).success).toBe(false);
  expect(listenerCollectionPageSchema.safeParse({
    ...basePage,
    included: { albums: [{ ...album, createdBy: 'private-owner' }], audioTracks: [] }
  }).success).toBe(false);
  expect(listenerCollectionPageSchema.safeParse({
    ...basePage,
    pageItem: { ...basePage.pageItem, contentType: 'audioTrack' }
  }).success).toBe(false);
  expect(listenerCollectionPageSchema.safeParse({
    ...basePage,
    limit: 1,
    nextCursor: 'x'.repeat(2_049)
  }).success).toBe(false);
});

test('Credit attribution is additive and prefers a resolved Organization byline', () => {
  const attributed = albumSummarySchema.parse({
    ...album,
    credits: [{
      subjectType: 'organization',
      subjectId: 'organization-1',
      name: 'Release House',
      role: 'label',
      order: 0
    }],
    displayByline: 'Release House',
    attributionStatus: 'documented'
  });
  expect(contentByline(attributed)).toBe('Release House');
  expect(contentByline(albumSummarySchema.parse(album))).toBe('Finitude Ensemble');
});

test('accepts a public Organization page without internal lifecycle fields', () => {
  expect(listenerOrganizationSchema.parse({
    organization: {
      id: 'organization-1',
      name: 'Release House',
      organizationType: 'label',
      description: 'Independent label'
    },
    releases: [album]
  }).organization.name).toBe('Release House');
  expect(listenerOrganizationSchema.safeParse({
    organization: {
      id: 'organization-1',
      name: 'Release House',
      organizationType: 'label',
      description: '',
      lifecycleStatus: 'ready'
    },
    releases: []
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
          mediaType: 'audio',
          available: true,
          streamUrl: '/content/mediaTrack/stream/track-1',
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
          mediaType: 'audio',
          available: true,
          streamUrl: '/content/mediaTrack/stream/track-1'
        }
      }
    ],
    nextCursor: null
  });
});
