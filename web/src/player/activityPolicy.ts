export type PlaybackActivityEvent =
  | { type: 'albumPlay'; albumId: string }
  | { type: 'explicitAlbumTrack'; trackId: string }
  | { type: 'standaloneTrack'; trackId: string }
  | { type: 'previous' }
  | { type: 'next' }
  | { type: 'auto' }
  | { type: 'restored' };

export interface PlaybackActivityTarget {
  contentType: 'album' | 'audioTrack';
  contentId: string;
}

/** Maps only explicit launches to server activity; queue navigation is always inert. */
export const playbackActivityTarget = (
  event: PlaybackActivityEvent
): PlaybackActivityTarget | null => {
  switch (event.type) {
    case 'albumPlay':
      return { contentType: 'album', contentId: event.albumId };
    case 'explicitAlbumTrack':
    case 'standaloneTrack':
      return { contentType: 'audioTrack', contentId: event.trackId };
    case 'previous':
    case 'next':
    case 'auto':
    case 'restored':
      return null;
  }
};
