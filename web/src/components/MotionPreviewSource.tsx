import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { motionPreviewUrl, presentationCapabilitiesQuery } from '../api/presentationCapabilities';

export interface MotionPreviewSourceProps {
  mediaTrackId: string;
  /** The public stream, used only while dedicated motion previews are disabled. */
  streamUrl: string;
  children: (source: string) => ReactNode;
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
  if (capabilities.isPending) return null;
  return children(capabilities.data?.motionPreviews ? motionPreviewUrl(mediaTrackId) : streamUrl);
}
