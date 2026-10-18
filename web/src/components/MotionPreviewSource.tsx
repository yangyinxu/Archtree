import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { motionPreviewUrl, presentationCapabilitiesQuery } from '../api/presentationCapabilities';

export interface MotionPreviewSourceProps {
  mediaTrackId: string;
  /** The public stream, used only while dedicated motion previews are disabled. */
  streamUrl: string;
  /** Receives the chosen source and whether it is the dedicated clip rather than the full stream. */
  children: (source: string, isClip: boolean) => ReactNode;
}

/**
 * Chooses a card preview's source once the presentation flags load: the dedicated muted clip when
 * the server serves motion previews (a track without one simply keeps its artwork), otherwise the
 * MediaTrack's public stream. It is a chunk of its own because it reads through the entry bundle's
 * API client; importing that from the preview directly would add a stylesheet preload table to the
 * card's shared bundle.
 */
export default function MotionPreviewSource({ mediaTrackId, streamUrl, children }: MotionPreviewSourceProps) {
  const capabilities = useQuery(presentationCapabilitiesQuery());
  // Unknown flags (still loading, or a failed read) show no preview rather than guessing: the public
  // stream is read only when the server says dedicated previews are disabled.
  if (!capabilities.data) return null;
  return capabilities.data.motionPreviews
    ? children(motionPreviewUrl(mediaTrackId), true)
    : children(streamUrl, false);
}
