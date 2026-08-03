import type { AudioTrackSummary } from '../../api/contentSchemas';
import { recordRecentlyPlayed } from '../../api/listener';
import {
  playbackActivityTarget,
  playerStore,
  type PlaybackActivityEvent,
  type PlayerQueueItem
} from '../../player';

/** Adapts the public soundtrack DTO to the player-owned queue contract. */
export const queueItemFromTrack = (track: AudioTrackSummary): PlayerQueueItem => ({
  id: track.id,
  title: track.title,
  artworkUrl: track.artworkUrl,
  artistNames: track.artistNames,
  streamUrl: track.streamUrl
});

const recordAfterPlaybackStarts = (viewerId: string | null | undefined, event: PlaybackActivityEvent) => {
  if (!viewerId || playerStore.getSnapshot().status !== 'playing') return;
  const target = playbackActivityTarget(event);
  if (!target) return;
  void recordRecentlyPlayed(target).catch(() => {
    // Activity history is best-effort and never interrupts public playback.
  });
};

/** Launches one soundtrack outside an Album queue and records only that soundtrack. */
export const launchStandalonePlayback = async (
  track: AudioTrackSummary,
  viewerId?: string | null
) => {
  await playerStore.launchStandalone(queueItemFromTrack(track));
  recordAfterPlaybackStarts(viewerId, { type: 'standaloneTrack', trackId: track.id });
};

/** Launches the complete playable Album queue from its first or explicitly chosen track. */
export const launchAlbumPlayback = async (
  albumId: string,
  tracks: AudioTrackSummary[],
  viewerId?: string | null,
  requestedTrackId?: string
) => {
  if (tracks.length === 0) return;
  const requestedIndex = requestedTrackId
    ? tracks.findIndex((track) => track.id === requestedTrackId)
    : -1;
  const initialIndex = requestedIndex >= 0 ? requestedIndex : 0;
  await playerStore.launchAlbumQueue(tracks.map(queueItemFromTrack), initialIndex);
  recordAfterPlaybackStarts(viewerId, requestedIndex >= 0
    ? { type: 'explicitAlbumTrack', trackId: tracks[initialIndex].id }
    : { type: 'albumPlay', albumId });
};
