import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, type ReactNode } from 'react';

import { motionPreviewUrl, presentationCapabilitiesQuery } from '../api/presentationCapabilities';
import { playerStore } from '../player/playerStore';

/** Keeps card audition outside the shared queue while preventing simultaneous audible playback. */
export interface PreviewPlaybackControls {
  beforeAudible(intent: 'hover' | 'explicit'): boolean;
  subscribeToPlayback(stop: () => void): () => void;
}

const playbackControls: PreviewPlaybackControls = {
  beforeAudible(intent) {
    // A card must never turn a private audition into a room-wide Pause command.
    if (playerStore.isRoomPlaybackActive()) return false;
    const main = playerStore.getSnapshot();
    // Automatic sound never interrupts an existing listening session, including a pending start.
    if (intent === 'hover') return !main.currentItem || !['playing', 'loading'].includes(main.status);
    if (main.currentItem) playerStore.pause();
    return !playerStore.isRoomPlaybackActive();
  },
  subscribeToPlayback(stop) {
    return playerStore.subscribePlaybackEvents(event => {
      if (['intent', 'sourcechange', 'play', 'playing'].includes(event.type)) stop();
    });
  }
};

export interface MotionPreviewSourceProps {
  mediaTrackId: string;
  /** The public stream retains sound for audible previews. */
  streamUrl: string;
  explicit?: boolean;
  audible?: boolean;
  /** Receives the chosen source and whether it is the dedicated clip rather than the full stream. */
  children: (source: string, isClip: boolean, playback: PreviewPlaybackControls) => ReactNode;
  /** A failed capability read cannot become an indefinitely pending explicit preview. */
  onUnavailable?: () => void;
}

/**
 * Chooses a card preview's source once the presentation flags load: the dedicated muted clip when
 * the server serves motion previews (a track without one simply keeps its artwork), otherwise the
 * MediaTrack's public stream. Audible or explicit previews retain the stream because clips have no
 * audio; later muting never replaces a running original with an unrelated silent clip.
 * It is a chunk of its own because it reads through the entry bundle's
 * API client; importing that from the preview directly would add a stylesheet preload table to the
 * card's shared bundle.
 */
export default function MotionPreviewSource({ mediaTrackId, streamUrl, explicit = false, audible = false, children, onUnavailable }: MotionPreviewSourceProps) {
  const capabilities = useQuery(presentationCapabilitiesQuery());
  const original = useRef({ mediaTrackId, streamUrl, pinned: explicit || audible });
  if (original.current.mediaTrackId !== mediaTrackId || original.current.streamUrl !== streamUrl) {
    original.current = { mediaTrackId, streamUrl, pinned: explicit || audible };
  } else if (explicit || audible) original.current.pinned = true;
  const roomBlocked = explicit && audible && playerStore.isRoomPlaybackActive();
  useEffect(() => {
    if (roomBlocked || !capabilities.data && capabilities.isError) onUnavailable?.();
  }, [capabilities.data, capabilities.isError, onUnavailable, roomBlocked]);
  // Unknown flags (still loading, or a failed read) show no preview rather than guessing: the public
  // source policy is applied only after the capability read succeeds.
  if (!capabilities.data || roomBlocked) return null;
  return capabilities.data.motionPreviews && !original.current.pinned
    ? children(motionPreviewUrl(mediaTrackId), true, playbackControls)
    : children(streamUrl, false, playbackControls);
}
