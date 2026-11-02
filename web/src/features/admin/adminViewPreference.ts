export type AdminView = 'user' | 'admin';

/** One account's presentation preference never chooses another account's view. */
export const adminViewPreferenceKey = (viewerId: string) =>
  `finitude:admin-view:v1:${encodeURIComponent(viewerId)}`;

/** Only a fresh capability authorization may apply this untrusted device-local hint. */
export const readAdminViewPreference = (viewerId: string): AdminView => {
  if (!viewerId) return 'user';
  try {
    return window.localStorage.getItem(adminViewPreferenceKey(viewerId)) === 'admin' ? 'admin' : 'user';
  } catch {
    return 'user';
  }
};

/** A blocked or full browser store must not prevent an explicit view change. */
export const writeAdminViewPreference = (viewerId: string, mode: AdminView) => {
  if (!viewerId || !['user', 'admin'].includes(mode)) return;
  try {
    window.localStorage.setItem(adminViewPreferenceKey(viewerId), mode);
  } catch {
    // The current page still remembers the selection when durable browser storage is unavailable.
  }
};
