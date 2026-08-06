import type {
  AlbumSummary,
  AudioTrackSummary,
  ListenerAlbum,
  ListenerHome
} from '../../src/api/contentSchemas';

/**
 * Reserved same-origin artwork slots served from browser-test fixtures. The
 * reviewed files stay outside `web/dist`, and tests never fetch remote art.
 */
export const visualArtworkSlots = {
  blueHour: '/__e2e__/artwork/first-light.jpg',
  paperMoon: '/__e2e__/artwork/night-window.jpg',
  quietGarden: '/__e2e__/artwork/quiet-hours.jpg'
} as const;

const albums = [
  {
    contentType: 'album',
    id: 'visual-blue-hour',
    title: '月明かりの記憶—風景を越えて響く長いタイトル',
    artworkUrl: visualArtworkSlots.blueHour,
    artistNames: ['林海と夜のアンサンブル 🌙'],
    releaseDate: { year: 2026, month: 8 }
  },
  {
    contentType: 'album',
    id: 'visual-paper-moon',
    title: 'Paper Moon / 纸月亮 ✨',
    artworkUrl: visualArtworkSlots.paperMoon,
    artistNames: ['Mira & 光'],
    releaseDate: { year: 2025 }
  },
  {
    contentType: 'album',
    id: 'visual-quiet-garden',
    title: '静かな庭',
    artworkUrl: visualArtworkSlots.quietGarden,
    artistNames: ['Finitude Ensemble'],
    releaseDate: null
  },
  {
    contentType: 'album',
    id: 'visual-afterglow-archive',
    title: 'Afterglow Archive',
    artworkUrl: visualArtworkSlots.blueHour,
    artistNames: ['Finitude Ensemble'],
    releaseDate: { year: 2024 }
  },
  {
    contentType: 'album',
    id: 'visual-starlit-letters',
    title: 'Starlit Letters',
    artworkUrl: visualArtworkSlots.paperMoon,
    artistNames: ['Mira & 光'],
    releaseDate: { year: 2023 }
  },
  {
    contentType: 'album',
    id: 'visual-missing-art',
    title: 'Missing artwork study',
    artworkUrl: '',
    artistNames: [],
    releaseDate: null
  }
] satisfies AlbumSummary[];

const tracks = [
  {
    contentType: 'audioTrack',
    id: 'visual-first-track',
    title: '深呼吸の手前で聞こえるとても長いサウンドトラック名',
    artworkUrl: visualArtworkSlots.blueHour,
    artistNames: ['群星 / Constellations'],
    albumId: albums[0].id,
    albumTitle: albums[0].title,
    duration: '3:51',
    streamUrl: '/content/audioTrack/stream/visual-first-track'
  },
  {
    contentType: 'audioTrack',
    id: 'visual-missing-metadata',
    title: '',
    artworkUrl: '',
    artistNames: [],
    albumId: null,
    albumTitle: null,
    duration: null,
    streamUrl: '/content/audioTrack/stream/visual-missing-metadata'
  },
  {
    contentType: 'audioTrack',
    id: 'visual-emoji-track',
    title: '🌌 Stardust in my memory card',
    artworkUrl: visualArtworkSlots.quietGarden,
    artistNames: ['ミロー 🎹'],
    albumId: albums[2].id,
    albumTitle: albums[2].title,
    duration: '4:02',
    streamUrl: '/content/audioTrack/stream/visual-emoji-track'
  }
] satisfies AudioTrackSummary[];

export const visualHomePlaybackTrack = tracks[0];

const visualAlbumSummary = {
  ...albums[0],
  title: 'Stillwater Rooms — My Dear Echoes (Original Soundtrack)',
  artistNames: ['Finitude Ensemble', 'Mira & 光'],
  releaseDate: { year: 2026 }
} satisfies AlbumSummary;

/** Mirrors the supplied compact-desktop Album state with an original-art queue. */
export const visualAlbumFixture = {
  album: visualAlbumSummary,
  tracks: [
    {
      ...tracks[0],
      albumId: visualAlbumSummary.id,
      albumTitle: visualAlbumSummary.title,
      title: 'First Light / 初光',
      artistNames: ['Finitude Ensemble'],
      duration: '0:15'
    },
    {
      contentType: 'audioTrack',
      id: 'visual-night-window',
      title: 'Night Window / 夜窓',
      artworkUrl: visualArtworkSlots.paperMoon,
      artistNames: ['Finitude Ensemble'],
      albumId: visualAlbumSummary.id,
      albumTitle: visualAlbumSummary.title,
      duration: '0:15',
      streamUrl: '/content/audioTrack/stream/visual-night-window'
    }
  ]
} satisfies ListenerAlbum;

/** Exercises Carousel, Grid, List, long text, emoji, and missing metadata. */
export const visualHomeFixture = {
  title: '音の余白—Visual QA Listening Room',
  sections: [
    {
      id: 'visual-carousel',
      title: '今日のおすすめ / Today’s recommendations',
      presentation: 'carousel',
      items: albums
    },
    {
      id: 'visual-grid',
      title: 'Albums across scripts 🌏',
      presentation: 'grid',
      items: albums
    },
    {
      id: 'visual-list',
      title: 'Soundtracks for focus',
      presentation: 'list',
      items: tracks
    }
  ]
} satisfies ListenerHome;
