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
