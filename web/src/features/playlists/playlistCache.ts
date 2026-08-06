import type { QueryClient, QueryKey } from '@tanstack/react-query';

import {
  isAccountOperationCurrent,
  type AccountOperationGuard
} from '../../api/accountEpoch';
import {
  playlistQueryKeys,
  type PlaylistDetail,
  type PlaylistPage,
  type PlaylistSummary
} from '../../api/playlists';

/** Projects a safe detail into the summary shape shared by index and sidebar caches. */
export const playlistSummaryFromDetail = (playlist: PlaylistDetail): PlaylistSummary => ({
  id: playlist.id,
  name: playlist.name,
  itemCount: playlist.itemCount,
  artworkUrl: playlist.artworkUrl,
  revision: playlist.revision,
  createdAt: playlist.createdAt,
  updatedAt: playlist.updatedAt
});

const newestFirst = (left: PlaylistSummary, right: PlaylistSummary) => {
  const byUpdatedAt = right.updatedAt.localeCompare(left.updatedAt);
  return byUpdatedAt || right.id.localeCompare(left.id);
};

const listLimitFromKey = (queryKey: QueryKey) => {
  const options = queryKey[3];
  if (!options || typeof options !== 'object' || !('limit' in options)) return 100;
  const limit = Number((options as { limit?: unknown }).limit);
  return Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 100;
};

/** Merges one confirmed detail into every cache owned by the same viewer. */
export const commitPlaylistDetail = (
  queryClient: QueryClient,
  viewerId: string,
  playlist: PlaylistDetail,
  guard: AccountOperationGuard
) => {
  if (!isAccountOperationCurrent(guard, viewerId)) return;
  queryClient.setQueryData(playlistQueryKeys.detail(viewerId, playlist.id), playlist);
  const summary = playlistSummaryFromDetail(playlist);
  for (const [queryKey, current] of queryClient.getQueriesData<PlaylistPage>({
    queryKey: playlistQueryKeys.lists(viewerId)
  })) {
    if (!current) continue;
    const items = [summary, ...current.items.filter((item) => item.id !== summary.id)]
      .sort(newestFirst)
      .slice(0, listLimitFromKey(queryKey));
    queryClient.setQueryData<PlaylistPage>(queryKey, { ...current, items });
  }
};

/** Removes private Playlist data immediately after confirmed deletion. */
export const removePlaylistFromCaches = (
  queryClient: QueryClient,
  viewerId: string,
  playlistId: string,
  guard: AccountOperationGuard
) => {
  if (!isAccountOperationCurrent(guard, viewerId)) return;
  queryClient.removeQueries({ queryKey: playlistQueryKeys.detail(viewerId, playlistId), exact: true });
  queryClient.setQueriesData<PlaylistPage>(
    { queryKey: playlistQueryKeys.lists(viewerId) },
    (current) => current
      ? { ...current, items: current.items.filter((item) => item.id !== playlistId) }
      : current
  );
};

/** Revalidates every pagination variant for one viewer after a confirmed write. */
export const revalidatePlaylistLists = (
  queryClient: QueryClient,
  viewerId: string,
  guard: AccountOperationGuard
) => isAccountOperationCurrent(guard, viewerId)
  ? queryClient.invalidateQueries({ queryKey: playlistQueryKeys.lists(viewerId) })
  : Promise.resolve();
