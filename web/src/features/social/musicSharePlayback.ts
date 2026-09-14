import { getCurrentRoom } from '../../api/rooms';
import { getListenerAlbum, getListenerTrack } from '../../api/listener';
import type { MusicShareItem } from '../../api/musicShares';
import { launchAlbumPlayback, launchStandalonePlayback } from '../playback/launchPlayback';
import { roomSession } from './roomSession';

/** Resolves membership and current catalog media only after an explicit, still-current personal Play gesture. */
export const playSharedMusic = async (viewerId: string, item: MusicShareItem, current: () => boolean) => {
  if (!current()) return false;
  // Cold transports begin with null before the account's actual membership is known.
  const membership = await getCurrentRoom(viewerId);
  if (!current()) return false;
  if (membership.room || roomSession.getSnapshot().room) { void roomSession.refresh(); return true; }
  const playable = () => current() && !roomSession.getSnapshot().room;
  if (item.contentType === 'album') {
    const album = await getListenerAlbum(item.contentId);
    if (playable()) {
      if (!album.tracks.length) throw new Error('Music unavailable.');
      await launchAlbumPlayback(album.album.id, album.tracks, viewerId);
    }
  } else {
    const track = await getListenerTrack(item.contentId);
    if (playable()) await launchStandalonePlayback(track.audioTrack, viewerId);
  }
  return Boolean(roomSession.getSnapshot().room);
};
