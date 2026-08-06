import { apiRequestNoContent, ApiError } from './client';
import { captureAccountOperation } from './accountEpoch';
import { logoutBrowserSessionUnlocked } from './session';
import { publishAccountSessionChange } from './accountSessionEvents';

const accountViewerHeaders = (viewerId: string) => ({
  'X-Finitude-Account-Viewer': viewerId
});

/** Removes Recently Played activity without mutating Saved Library content. */
export const clearAccountListeningHistory = (viewerId: string) => apiRequestNoContent(
  '/auth/activity/listening-history',
  {
    method: 'DELETE',
    body: '{}',
    headers: accountViewerHeaders(viewerId),
    accountViewer: viewerId
  }
);

/** Revokes every server session before asking the browser to clear its HttpOnly cookies. */
export const signOutAccountEverywhere = async (viewerId: string) => {
  const { runBrowserSessionTransition } = await import('./sessionTransition');
  return runBrowserSessionTransition({
    kind: 'logout-all',
    changesIdentity: true,
    onConflict: () => logoutBrowserSessionUnlocked(viewerId)
  }, async (capability, generation) => {
    await apiRequestNoContent('/auth/logout-all', {
      method: 'POST',
      body: '{}',
      headers: accountViewerHeaders(viewerId),
      accountViewer: viewerId
    });
    try {
      await logoutBrowserSessionUnlocked(viewerId, capability);
    } catch {
      // Every server session is already invalid; local privacy cleanup must still finish.
    }
    publishAccountSessionChange('logout-all');
    return captureAccountOperation(viewerId, generation);
  });
};

/** Deletes the account, then clears the now-unusable browser cookies on the same origin. */
export const deleteListenerAccount = async (viewerId: string) => {
  const { runBrowserSessionTransition } = await import('./sessionTransition');
  return runBrowserSessionTransition({
    kind: 'account-delete',
    changesIdentity: true,
    onConflict: () => logoutBrowserSessionUnlocked(viewerId)
  }, async (capability, generation) => {
    await apiRequestNoContent('/auth/account', {
      method: 'DELETE',
      body: '{}',
      headers: accountViewerHeaders(viewerId),
      accountViewer: viewerId
    });
    try {
      await logoutBrowserSessionUnlocked(viewerId, capability);
    } catch {
      // The deleted identity can no longer authorize requests; clear local state regardless.
    }
    publishAccountSessionChange('account-deleted');
    return captureAccountOperation(viewerId, generation);
  });
};

/** Identifies the server's recoverable avatar prerequisite without matching human copy. */
export const isAvatarDeletionRequired = (error: unknown) =>
  error instanceof ApiError && error.code === 'requires_avatar_deletion';
