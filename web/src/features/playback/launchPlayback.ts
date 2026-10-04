import type { AudioTrackSummary } from '../../api/contentSchemas';
import { captureAccountOperation, isAccountOperationCurrent, type AccountOperationGuard } from '../../api/accountEpoch';
import {
  playbackActivityTarget,
  playerStore,
  type PlaybackActivityEvent,
  type PlayerQueueItem
} from '../../player';

let latestPlaybackLaunch = 0;

/** Adapts the compatibility-named public track DTO to the MediaTrack queue contract. */
export const queueItemFromTrack = (track: AudioTrackSummary): PlayerQueueItem => ({
  id: track.id,
  title: track.title,
  artworkUrl: track.artworkUrl,
  artistNames: track.artistNames,
  displayByline: track.displayByline,
  mediaType: track.mediaType,
  streamUrl: track.streamUrl
});

const recordAfterPlaybackStarts = (
  guard: AccountOperationGuard | undefined,
  event: PlaybackActivityEvent,
  launchGeneration: number,
  expectedTrackId: string
) => {
  const snapshot = playerStore.getSnapshot();
  if (!guard || !isAccountOperationCurrent(guard)
    || launchGeneration !== latestPlaybackLaunch
    || snapshot.status !== 'playing'
    || snapshot.currentItem?.id !== expectedTrackId) return;
  const target = playbackActivityTarget(event);
  if (!target) return;
  void import('./recordPlaybackHistory').then(({ recordPlaybackHistory }) => {
    return recordPlaybackHistory(target, guard.viewerId, guard);
  }).catch(() => {
    // Activity history is best-effort and never interrupts public playback.
  });
};

/** Launches one MediaTrack outside an Album queue and records only that item. */
export const launchStandalonePlayback = async (
  track: AudioTrackSummary,
  viewerId?: string | null
) => {
  const launchGeneration = ++latestPlaybackLaunch;
  const guard = viewerId ? captureAccountOperation(viewerId) : undefined;
  await playerStore.launchStandalone(queueItemFromTrack(track));
  recordAfterPlaybackStarts(
    guard,
    { type: 'standaloneTrack', trackId: track.id },
    launchGeneration,
    track.id
  );
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
  const launchGeneration = ++latestPlaybackLaunch;
  const guard = viewerId ? captureAccountOperation(viewerId) : undefined;
  await playerStore.launchAlbumQueue(tracks.map(queueItemFromTrack), initialIndex);
  recordAfterPlaybackStarts(
    guard,
    requestedIndex >= 0
      ? { type: 'explicitAlbumTrack', trackId: tracks[initialIndex].id }
      : { type: 'albumPlay', albumId },
    launchGeneration,
    tracks[initialIndex].id
  );
};

/** Launches a ready-only Playlist snapshot and records only its explicit start track. */
export const launchPlaylistPlayback = async (
  tracks: AudioTrackSummary[],
  viewerId?: string | null,
  requestedTrackId?: string
) => {
  if (tracks.length === 0) return;
  const requestedIndex = requestedTrackId
    ? tracks.findIndex((track) => track.id === requestedTrackId)
    : -1;
  const initialIndex = requestedIndex >= 0 ? requestedIndex : 0;
  const launchGeneration = ++latestPlaybackLaunch;
  const guard = viewerId ? captureAccountOperation(viewerId) : undefined;
  await playerStore.launchQueue(tracks.map(queueItemFromTrack), initialIndex);
  recordAfterPlaybackStarts(
    guard,
    { type: 'playlistTrack', trackId: tracks[initialIndex].id },
    launchGeneration,
    tracks[initialIndex].id
  );
};
