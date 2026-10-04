import { z } from 'zod';
import { socialReadRequest } from './socialReadRequest';
import { socialRevisionSchema } from './socialSchemas';

/**
 * Reads the account's payload-free social change cursor, the HTTP counterpart of the room
 * socket's `socialChanged` message. Only inequality is meaningful: the counter can skip values.
 */
export const getSocialChangeRevision = (viewerId: string, signal?: AbortSignal) =>
  socialReadRequest('/api/social/v1/me/changes', z.object({ revision: socialRevisionSchema }).strict(), {
    accountViewer: viewerId, signal
  });
