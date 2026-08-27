import type {
  AlbumSummary,
  ArtistSummary,
  AudioTrackSummary,
  HomeSection,
  ListenerAlbum,
  ListenerHome,
  ListenerSearch
} from '../../src/api/contentSchemas';
import type { ListenerCollectionPage } from '../../src/api/collectionSchemas';

export const catalogIds = {
  album: 'e2e-quiet-hours',
  artist: 'e2e-finitude-ensemble',
  firstTrack: 'e2e-first-light',
  secondTrack: 'e2e-night-window'
} as const;

export const homePageItemIds = {
  focusTracks: '64b000000000000000000101'
} as const;

export const artistFixture = {
  contentType: 'artist',
  id: catalogIds.artist,
  name: 'Finitude Ensemble',
  bio: 'A deterministic artist fixture for browser testing.',
  artworkUrl: ''
} satisfies ArtistSummary;

export const albumFixture = {
  contentType: 'album',
  id: catalogIds.album,
  title: 'Quiet Hours',
  artworkUrl: '',
  artistNames: [artistFixture.name],
  releaseDate: { year: 2026, month: 8 }
} satisfies AlbumSummary;

export const trackFixtures = [
  {
    contentType: 'audioTrack',
    id: catalogIds.firstTrack,
    title: 'First Light',
    artworkUrl: '',
    artistNames: [artistFixture.name],
    albumId: catalogIds.album,
    albumTitle: albumFixture.title,
    duration: '0:15',
    mediaType: 'video',
    streamUrl: `/content/mediaTrack/stream/${catalogIds.firstTrack}`
  },
  {
    contentType: 'audioTrack',
    id: catalogIds.secondTrack,
    title: 'Night Window',
    artworkUrl: '',
    artistNames: [artistFixture.name],
    albumId: catalogIds.album,
    albumTitle: albumFixture.title,
    duration: '0:15',
    mediaType: 'audio',
    streamUrl: `/content/mediaTrack/stream/${catalogIds.secondTrack}`
  }
] satisfies AudioTrackSummary[];

export const homeFixture = {
  title: 'Browser Test Listening Room',
  sections: [
    {
      id: 'e2e-featured-albums',
      title: 'Featured albums',
      presentation: 'carousel',
      items: [albumFixture]
    },
    {
      id: homePageItemIds.focusTracks,
      title: 'MediaTracks for focus',
      presentation: 'list',
      items: trackFixtures
    }
  ]
} satisfies ListenerHome;

/** Mirrors the page-scoped endpoint while keeping parent compatibility payloads available. */
export const collectionPageFixture = (
  section: HomeSection,
  pageSlug: 'home' | 'library' = 'home'
): ListenerCollectionPage => {
  if (section.presentation === 'carousel') {
    throw new Error('Carousel sections do not use the Grid/List pagination fixture.');
  }
  const contentType = section.items[0]?.contentType
    ?? (section.presentation === 'grid' ? 'album' : 'audioTrack');
  if (section.items.some((item) => item.contentType !== contentType)
    || (section.presentation === 'grid' && contentType !== 'album')) {
    throw new Error('Grid/List pagination fixtures must be homogeneous and presentation-safe.');
  }
  return {
    pageItem: {
      id: section.id,
      pageSlug,
      title: section.title,
      presentation: section.presentation,
      mode: 'manual',
      contentType
    },
    items: section.items.map((item, order) => ({
      contentType: item.contentType,
      contentId: item.id,
      order
    })),
    included: {
      albums: section.items.filter((item) => item.contentType === 'album'),
      audioTracks: section.items.filter((item) => item.contentType === 'audioTrack')
    },
    limit: 20,
    nextCursor: null
  };
};

export const homeCollectionPageFixture = collectionPageFixture(homeFixture.sections[1]);

export const expandedAlbumFixture = {
  album: albumFixture,
  tracks: trackFixtures
} satisfies ListenerAlbum;

/** Keeps every submitted query grouped while preserving the requested text. */
export const searchFixture = (query: string) => ({
  query,
  artists: [artistFixture],
  organizations: [],
  albums: [albumFixture],
  audioTracks: trackFixtures
}) satisfies ListenerSearch;
