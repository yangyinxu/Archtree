import { queryOptions } from '@tanstack/react-query';
import { z } from 'zod';

import { apiRequest } from './client';

// Additive fields are ignored, so a newer server never breaks this decoder (unlike the strict rollout flags).
const presentationCapabilitiesSchema = z.object({
  contractVersion: z.literal(1),
  motionPreviews: z.boolean()
}).strip();

export const presentationCapabilitiesQueryKey = ['listener', 'presentation-capabilities'] as const;

/** Reads decorative presentation flags; loaded only by the lazy card preview. */
export const presentationCapabilitiesQuery = () => queryOptions({
  queryKey: presentationCapabilitiesQueryKey,
  queryFn: ({ signal }) => apiRequest('/api/listener/v1/presentation-capabilities', presentationCapabilitiesSchema, {
    signal,
    retryAuthentication: false
  }),
  retry: false,
  // A failed read shows no previews; later hovers do not re-request it until the query is collected.
  retryOnMount: false,
  staleTime: 5 * 60_000
});

/** The dedicated muted preview clip of one Video MediaTrack. */
export const motionPreviewUrl = (mediaTrackId: string) => (
  `/content/mediaTrack/motion-preview/${encodeURIComponent(mediaTrackId)}`
);
