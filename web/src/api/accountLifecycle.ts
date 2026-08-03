import { apiRequestNoContent, ApiError } from './client';
import { logoutBrowserSession } from './session';

const accountViewerHeaders = (viewerId: string) => ({
  'X-Finitude-Account-Viewer': viewerId
});

/** Removes Recently Played activity without mutating Saved Library content. */
export const clearAccountListeningHistory = (viewerId: string) => apiRequestNoContent(
  '/auth/activity/listening-history',
  { method: 'DELETE', body: '{}', headers: accountViewerHeaders(viewerId) }
);

/** Revokes every server session before asking the browser to clear its HttpOnly cookies. */
export const signOutAccountEverywhere = async (viewerId: string) => {
  await apiRequestNoContent('/auth/logout-all', {
    method: 'POST',
    body: '{}',
    headers: accountViewerHeaders(viewerId)
  });
  try {
    await logoutBrowserSession(viewerId);
  } catch {
    // Every server session is already invalid; local privacy cleanup must still finish.
  }
};

/** Deletes the account, then clears the now-unusable browser cookies on the same origin. */
export const deleteListenerAccount = async (viewerId: string) => {
  await apiRequestNoContent('/auth/account', {
    method: 'DELETE',
    body: '{}',
    headers: accountViewerHeaders(viewerId)
  });
  try {
    await logoutBrowserSession(viewerId);
  } catch {
    // The deleted identity can no longer authorize requests; clear local state regardless.
  }
};

/** Identifies the server's recoverable avatar prerequisite without matching human copy. */
export const isAvatarDeletionRequired = (error: unknown) =>
  error instanceof ApiError && error.code === 'requires_avatar_deletion';
