import type { QueryClient } from '@tanstack/react-query';
import { isAccountOperationCurrent, type AccountOperationGuard } from './accountEpoch';
import type { SaveStatus } from './contentSchemas';

/** Commits a confirmed Save receipt without letting an older read or account restore stale state. */
export const commitSaveStatus = async (client: QueryClient, result: SaveStatus, guard: AccountOperationGuard) => {
  if (!isAccountOperationCurrent(guard)) return false;
  const queryKey = ['listener', 'save-statuses', guard.viewerId];
  await client.cancelQueries({ queryKey });
  if (!isAccountOperationCurrent(guard)) return false;
  client.setQueriesData<{ items: SaveStatus[] }>({ queryKey }, (current) => current && ({
    items: current.items.map((item) => item.contentType === result.contentType && item.contentId === result.contentId
      ? result : item)
  }));
  void Promise.all([
    client.invalidateQueries({ queryKey: ['listener', 'home', guard.viewerId] }),
    client.invalidateQueries({ queryKey: ['listener', 'library', guard.viewerId] }),
    client.invalidateQueries({ queryKey })
  ]);
  return true;
};
