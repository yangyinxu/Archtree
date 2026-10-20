import { adminRequest, importPath, type ImportDetail } from './adminApi';
import type { ImportLookupResponse } from './importLookupApi';

/** Lookup states Publish waits for; the summary polls while one lasts. */
export const lookupActive = (state: string | undefined) => state === 'queued' || state === 'running' || state === 'retrying';

/**
 * The Review and publish summary read (GET /imports/:id/lookup): the lookup view and the server's summary state. It is read again
 * whenever the project's revision or automatic values change, and polled every 3 seconds while a lookup is queued or running, or
 * waits on a busy source (a throttled source is retried within seconds), and every 10 while it waits out an outage; also every 3
 * seconds while the applied release's cover is being staged. The summary,
 * the Analyze confirmation and the publication checklist share it; its strict schema loads with the read, so none of their chunks
 * carries it.
 */
export function importSummaryQuery(access: { viewerId: string; epoch: number; generation: number }, item: Pick<ImportDetail, 'id' | 'revision' | 'valueRevision'>, online = true) {
  return {
    queryKey: ['admin-imports', access.viewerId, access.epoch, access.generation, item.id, 'summary', item.revision, item.valueRevision],
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<ImportLookupResponse> => {
      const { lookupResponseSchema } = await import('./importLookupApi');
      return adminRequest(`${importPath(item.id)}/lookup`, lookupResponseSchema, { signal });
    },
    retry: false, gcTime: 0,
    refetchInterval: (query: { state: { data?: ImportLookupResponse } }) => {
      const lookup = query.state.data?.lookup, state = lookup?.state;
      if (online && !lookupActive(state) && query.state.data?.summary.waiting.cover) return 3_000;
      return online && lookupActive(state) ? state === 'retrying' && lookup?.issue !== 'sourceBusy' ? 10_000 : 3_000 : false;
    }
  };
}
