import type { LibraryTarget } from '../../api/contentSchemas';
import { recordRecentlyPlayed } from '../../api/listener';
import { isAccountOperationCurrent, type AccountOperationGuard } from '../../api/accountEpoch';
import { queryClient } from '../../app/queryClient';

/** Defers private history refresh until playback starts, preserving the account fence. */
export const recordPlaybackHistory = async (target: LibraryTarget, viewerId: string, guard: AccountOperationGuard) => {
  if (!isAccountOperationCurrent(guard, viewerId)) return;
  await recordRecentlyPlayed(target, viewerId);
  if (!isAccountOperationCurrent(guard, viewerId)) return;
  await Promise.all(['library', 'home'].map((source) => queryClient.invalidateQueries({ queryKey: ['listener', source, viewerId] })));
};
