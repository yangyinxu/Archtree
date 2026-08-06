import type {
  LibraryPage,
  ListenerArtist
} from '../../src/api/contentSchemas';
import type {
  PlaylistDetail,
  PlaylistSummary
} from '../../src/api/playlists';
import type { BrowserSession } from '../../src/api/schemas';
import {
  albumFixture,
  artistFixture,
  trackFixtures
} from './catalog';

export const privateViewerId = 'e2e-private-listener';

/** Stable authenticated identity used only by browser-owned private-surface tests. */
export const privateViewerSession = {
  user: {
    id: privateViewerId,
    email: 'listener@example.com',
    role: 'user',
    displayName: '林海 Listener',
    avatarRevision: 0,
    avatar: null,
    emailVerified: true,
    authenticationMethods: ['password']
  }
} satisfies BrowserSession;

export const privatePlaylistSummary = {
  id: 'e2e-private-playlist',
  name: '夜のプレイリスト 🌙',
  itemCount: trackFixtures.length,
  artworkUrl: '',
  revision: 3,
  createdAt: '2026-08-04T13:00:00.000Z',
  updatedAt: '2026-08-05T09:30:00.000Z'
} satisfies PlaylistSummary;

export const privatePlaylistDetail = {
  ...privatePlaylistSummary,
  items: trackFixtures.map((track, index) => ({
    itemId: `e2e-private-item-${index + 1}`,
    audioTrackId: track.id,
    addedAt: `2026-08-04T13:0${index}:00.000Z`,
    availability: 'ready' as const,
    audioTrack: track
  }))
} satisfies PlaylistDetail;

export const privateLibraryPage = {
  items: [
    {
      contentType: 'album',
      contentId: albumFixture.id,
      savedAt: '2026-08-03T10:00:00.000Z',
      lastPlayedAt: '2026-08-05T08:00:00.000Z',
      lastActivityAt: '2026-08-05T08:00:00.000Z',
      creator: artistFixture.name,
      album: {
        _id: albumFixture.id,
        title: albumFixture.title,
        coverArtUrl: albumFixture.artworkUrl,
        releaseDate: albumFixture.releaseDate
      }
    },
    {
      contentType: 'audioTrack',
      contentId: trackFixtures[0].id,
      savedAt: '2026-08-04T11:00:00.000Z',
      lastPlayedAt: null,
      lastActivityAt: '2026-08-04T11:00:00.000Z',
      creator: artistFixture.name,
      audioTrack: {
        _id: trackFixtures[0].id,
        title: trackFixtures[0].title,
        displayCoverArtUrl: trackFixtures[0].artworkUrl,
        coverArtUrl: trackFixtures[0].artworkUrl,
        albumId: trackFixtures[0].albumId,
        duration: trackFixtures[0].duration,
        available: true,
        streamUrl: trackFixtures[0].streamUrl
      }
    }
  ],
  nextCursor: null
} satisfies LibraryPage;

export const privateArtistPage = {
  artist: artistFixture,
  albums: [albumFixture],
  audioTracks: trackFixtures
} satisfies ListenerArtist;
