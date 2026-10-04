import { QueryClient } from '@tanstack/react-query';
import { advanceAccountEpoch, captureAccountOperation } from './accountEpoch';
import { listenerQueryKeys } from './listener';
import { commitSaveStatus } from './saveCache';

const target = { contentType: 'album' as const, contentId: 'album-1' };
const oldState = { items: [{ ...target, saved: false }] };

test('confirmed Save replaces every current viewer batch and fences an older pending read', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const key = listenerQueryKeys.saveStatuses('viewer-1', [target]);
  const otherKey = listenerQueryKeys.saveStatuses('viewer-2', [target]);
  client.setQueryData(key, oldState);
  client.setQueryData(otherKey, oldState);
  let finish!: (value: typeof oldState) => void;
  const pending = client.fetchQuery({ queryKey: key, queryFn: () => new Promise<typeof oldState>((resolve) => { finish = resolve; }) });
  const canceled = pending.catch(() => undefined);
  expect(await commitSaveStatus(client, { ...target, saved: true }, captureAccountOperation('viewer-1'))).toBe(true);
  finish(oldState);
  await canceled;
  expect(client.getQueryData(key)).toEqual({ items: [{ ...target, saved: true }] });
  expect(client.getQueryData(otherKey)).toEqual(oldState);
});

test('an account transition during cache cancellation cannot commit a departing viewer receipt', async () => {
  const client = new QueryClient();
  const key = listenerQueryKeys.saveStatuses('viewer-1', [target]);
  client.setQueryData(key, oldState);
  let release!: () => void;
  vi.spyOn(client, 'cancelQueries').mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
  const commit = commitSaveStatus(client, { ...target, saved: true }, captureAccountOperation('viewer-1'));
  advanceAccountEpoch();
  client.removeQueries({ queryKey: key });
  release();
  expect(await commit).toBe(false);
  expect(client.getQueryData(key)).toBeUndefined();
});
