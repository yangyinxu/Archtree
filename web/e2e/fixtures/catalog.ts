import type {
  AlbumSummary,
  ArtistSummary,
  AudioTrackSummary,
  ListenerAlbum,
  ListenerHome,
  ListenerSearch
} from '../../src/api/contentSchemas';

export const catalogIds = {
  album: 'e2e-quiet-hours',
  artist: 'e2e-finitude-ensemble',
  firstTrack: 'e2e-first-light',
  secondTrack: 'e2e-night-window'
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
    streamUrl: `/content/audioTrack/stream/${catalogIds.firstTrack}`
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
    streamUrl: `/content/audioTrack/stream/${catalogIds.secondTrack}`
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
      id: 'e2e-focus-soundtracks',
      title: 'Soundtracks for focus',
      presentation: 'list',
      items: trackFixtures
    }
  ]
} satisfies ListenerHome;

export const expandedAlbumFixture = {
  album: albumFixture,
  tracks: trackFixtures
} satisfies ListenerAlbum;

/** Keeps every submitted query grouped while preserving the requested text. */
export const searchFixture = (query: string) => ({
  query,
  artists: [artistFixture],
  albums: [albumFixture],
  audioTracks: trackFixtures
}) satisfies ListenerSearch;
