import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { advanceAccountEpoch } from '../../api/accountEpoch';
import type { SocialCommand } from '../../api/social';

const mocks = vi.hoisted(() => ({ prepare: vi.fn(), send: vi.fn() }));
vi.mock('../../api/social', () => ({ prepareSocialCommand: mocks.prepare, sendSocialCommand: mocks.send, getSocialOutcome: vi.fn() }));
import { useSocialActions } from './useSocialActions';

test('a social dialog does not dispatch under a replacement login after awaiting its mutation scope', async () => {
  let resolve!: (value: SocialCommand) => void;
  mocks.prepare.mockReturnValue(new Promise<SocialCommand>(yes => { resolve = yes; }));
  const queryClient = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  const { result, unmount } = renderHook(() => useSocialActions('alice'), { wrapper });
  const action = { action: 'request' as const, targetSocialId: `s_${'a'.repeat(32)}`, expectedRevision: 0 };
  let pending!: Promise<void>;
  act(() => { pending = result.current.run(action); });
  advanceAccountEpoch();
  await act(async () => { resolve({ ...action, commandId: 'captured-command-01', scopeToken: 'captured-scope-token' }); await pending; });
  expect(mocks.send).not.toHaveBeenCalled();
  expect(result.current.uncertain).toBeNull();
  unmount(); queryClient.clear();
});

test.each([
  ['handle_reserved', 'social.handle_reserved'],
  ['alias_reserved', 'social.alias_reserved'],
  ['handle_unavailable', 'social.stale'],
  [undefined, 'social.stale']
] as const)('a durable %s profile rejection shows %s without retaining the command', async (code, message) => {
  const action = { action: 'profile' as const, expectedRevision: 0, handle: 'adm1n', alias: 'Finitude Support', discoverable: true };
  mocks.prepare.mockResolvedValue({ ...action, commandId: 'captured-command-02', scopeToken: 'captured-scope-token' });
  mocks.send.mockResolvedValue({ commandId: 'captured-command-02', outcome: 'rejected', replayed: false, ...(code ? { code } : {}) });
  const queryClient = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  const { result, unmount } = renderHook(() => useSocialActions('alice'), { wrapper });
  await act(async () => { await result.current.run(action); });
  expect(mocks.send).toHaveBeenCalledTimes(1);
  expect(result.current.message).toBe(message);
  expect(result.current.uncertain).toBeNull();
  unmount(); queryClient.clear(); mocks.prepare.mockReset(); mocks.send.mockReset();
});
