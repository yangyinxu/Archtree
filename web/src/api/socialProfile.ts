import { z } from 'zod';
import { socialProfileSchema } from './socialSchemas';
import { socialReadRequest } from './socialReadRequest';

/** Reads profile admission without loading command preparation and mutation recovery. */
export const getSocialProfile = (viewerId: string, signal?: AbortSignal) =>
  socialReadRequest('/api/social/v1/me/profile', z.object({ profile: socialProfileSchema.nullable() }).strict(), {
    accountViewer: viewerId, signal
  });
