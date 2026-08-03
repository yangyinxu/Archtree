import { queryOptions } from '@tanstack/react-query';
import { z } from 'zod';

import { ApiError, apiRequest } from './client';
import { getBrowserSession } from './session';

const avatarMetadataSchema = z
  .object({
    assetId: z.string().min(1),
    revision: z.number().int().nonnegative()
  })
  .strict();

export const avatarMutationResultSchema = z
  .object({
    avatarRevision: z.number().int().nonnegative(),
    avatar: avatarMetadataSchema.nullable(),
    cleanupPending: z.boolean().optional()
  })
  .strict();

export type AvatarMutationResult = z.infer<typeof avatarMutationResultSchema>;

export const privateAvatarQueryKey = (viewerId: string, revision: number) => (
  ['account', viewerId, 'avatar', revision] as const
);

const readPrivateAvatar = (viewerId: string, revision: number, signal?: AbortSignal) => fetch('/auth/avatar', {
  cache: 'no-store',
  credentials: 'same-origin',
  headers: {
    Accept: 'image/*',
    'X-Finitude-Avatar-Revision': String(revision),
    'X-Finitude-Avatar-Viewer': viewerId
  },
  signal
});

/** Loads private bytes after cookie refresh without ever accepting another account's response. */
export const getPrivateAvatar = async (
  viewerId: string,
  revision: number,
  signal?: AbortSignal
) => {
  if (!viewerId || !Number.isSafeInteger(revision) || revision < 0) {
    throw new ApiError('The profile photo identity is invalid.', 'invalid-response');
  }

  let response: Response;
  try {
    response = await readPrivateAvatar(viewerId, revision, signal);
    if (response.status === 401) {
      const session = await getBrowserSession();
      if (!session || session.user.id !== viewerId) {
        throw new ApiError('Your listening session has expired.', 'http', 401);
      }
      response = await readPrivateAvatar(viewerId, revision, signal);
    }
  } catch (error) {
    if (error instanceof ApiError || (error instanceof DOMException && error.name === 'AbortError')) {
      throw error;
    }
    throw new ApiError('Finitude is having trouble loading your profile photo.', 'network');
  }

  if (!response.ok) {
    throw new ApiError(
      response.status === 404
        ? 'The profile photo is no longer available.'
        : 'Finitude could not load your profile photo.',
      'http',
      response.status
    );
  }

  const contentType = response.headers.get('Content-Type')?.toLowerCase() ?? '';
  if (!contentType.startsWith('image/')) {
    throw new ApiError('The server returned an invalid profile photo.', 'invalid-response', response.status);
  }
  const blob = await response.blob();
  if (!blob.size) {
    throw new ApiError('The server returned an empty profile photo.', 'invalid-response', response.status);
  }
  return blob;
};

/** Keys private image bytes by both account and authoritative revision. */
export const privateAvatarQuery = (viewerId: string, revision: number, enabled = true) => queryOptions({
  queryKey: privateAvatarQueryKey(viewerId, revision),
  queryFn: ({ signal }) => getPrivateAvatar(viewerId, revision, signal),
  enabled: enabled && Boolean(viewerId),
  retry: false,
  staleTime: Number.POSITIVE_INFINITY
});

const mutationHeaders = (revision: number, idempotencyKey: string) => ({
  'Idempotency-Key': idempotencyKey,
  'If-Match': String(revision)
});

const newIdempotencyKey = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // randomUUID is present in supported browsers; this fallback keeps non-browser tests deterministic enough.
  return `avatar-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

/** Sends one confirmed JPEG crop with the same revision and idempotency contract as iOS. */
export const replaceAvatar = (
  jpeg: Blob,
  revision: number,
  viewerId: string,
  idempotencyKey = newIdempotencyKey()
) => {
  const boundary = `FinitudeWebAvatar-${newIdempotencyKey()}`;
  const body = new Blob([
    `--${boundary}\r\n`,
    'Content-Disposition: form-data; name="avatar"; filename="avatar.jpg"\r\n',
    'Content-Type: image/jpeg\r\n\r\n',
    jpeg,
    `\r\n--${boundary}--\r\n`
  ]);

  return apiRequest('/auth/avatar', avatarMutationResultSchema, {
    method: 'PUT',
    headers: {
      ...mutationHeaders(revision, idempotencyKey),
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'X-Finitude-Avatar-Viewer': viewerId
    },
    body
  });
};

/** Deletes only the avatar at the caller's last server-confirmed revision. */
export const deleteAvatar = (
  revision: number,
  viewerId: string,
  idempotencyKey = newIdempotencyKey()
) => apiRequest('/auth/avatar', avatarMutationResultSchema, {
  method: 'DELETE',
  body: '{}',
  headers: {
    ...mutationHeaders(revision, idempotencyKey),
    'X-Finitude-Avatar-Viewer': viewerId
  }
});
