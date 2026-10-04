import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { advanceAccountEpoch } from '../../api/accountEpoch';
import { ApiError } from '../../api/client';
import type { SocialAction, SocialCommand } from '../../api/social';

const mocks = vi.hoisted(() => ({ prepare: vi.fn(), send: vi.fn(), outcome: vi.fn() }));
vi.mock('../../api/social', () => ({ prepareSocialCommand: mocks.prepare, sendSocialCommand: mocks.send, getSocialOutcome: mocks.outcome }));
import { useSocialActions } from './useSocialActions';

const target = `s_${'a'.repeat(32)}`;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.prepare.mockImplementation(async (_viewer: string, action: SocialAction) => ({ ...action, commandId: 'captured-command-01', scopeToken: 'captured-scope-token' }));
});
/** Renders the hook against a real query client so refreshes after an outcome run as in the page. */
const renderActions = () => {
  const queryClient = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  return { ...renderHook(() => useSocialActions('alice'), { wrapper }), queryClient };
};
const rejected = (code: string) => ({ commandId: 'captured-command-01', outcome: 'rejected' as const, code, replayed: false });

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
  ['handle_unavailable', 'social.handle_unavailable'],
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

test.each([
  [{ action: 'report' as const, targetSocialId: `s_${'b'.repeat(32)}`, reason: 'spam' as const }, 'applied', undefined, 'social.report_sent'],
  [{ action: 'report' as const, targetSocialId: `s_${'b'.repeat(32)}`, reason: 'spam' as const }, 'noop', undefined, 'social.report_sent'],
  [{ action: 'report' as const, targetSocialId: `s_${'b'.repeat(32)}`, reason: 'spam' as const }, 'rejected', 'social_limit', 'social.report_limit'],
  [{ action: 'report' as const, targetSocialId: `s_${'b'.repeat(32)}`, reason: 'spam' as const }, 'rejected', 'profile_unavailable', 'social.profile_unavailable'],
  [{ action: 'request' as const, targetSocialId: `s_${'b'.repeat(32)}`, expectedRevision: 0 }, 'rejected', 'social_limit', 'social.request_limit'],
  [{ action: 'profile' as const, expectedRevision: 2, handle: 'alice', alias: 'Alice', discoverable: true }, 'rejected', 'social_suspended', 'social.suspended_action']
] as const)('%o settling as %s %s shows %s', async (action, outcome, code, message) => {
  mocks.prepare.mockResolvedValue({ ...action, commandId: 'captured-command-03', scopeToken: 'captured-scope-token' });
  mocks.send.mockResolvedValue({ commandId: 'captured-command-03', outcome, replayed: false, ...(code ? { code } : {}) });
  const queryClient = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  const { result, unmount } = renderHook(() => useSocialActions('alice'), { wrapper });
  await act(async () => { await result.current.run(action); });
  expect(result.current.message).toBe(message);
  expect(result.current.uncertain).toBeNull();
  unmount(); queryClient.clear(); mocks.prepare.mockReset(); mocks.send.mockReset();
});

test.each([
  [{ action: 'profile', handle: 'alice', alias: 'Alice', discoverable: true, expectedRevision: 0 }, 'handle_unavailable', 'social.handle_unavailable'],
  [{ action: 'profile', handle: 'alice', alias: 'Alice', discoverable: true, expectedRevision: 1 }, 'handle_immutable', 'social.handle_locked'],
  [{ action: 'request', targetSocialId: target, expectedRevision: 0 }, 'request_pending', 'social.request_incoming'],
  [{ action: 'request', targetSocialId: target, expectedRevision: 0 }, 'social_limit', 'social.request_limit'],
  [{ action: 'accept', targetSocialId: target, expectedRevision: 4 }, 'social_limit', 'social.friend_limit'],
  [{ action: 'block', targetSocialId: target }, 'social_limit', 'social.block_limit'],
  [{ action: 'remove', targetSocialId: target, expectedRevision: 4 }, 'profile_unavailable', 'social.profile_unavailable'],
  [{ action: 'accept', targetSocialId: target, expectedRevision: 4 }, 'relationship_changed', 'social.stale']
] as [SocialAction, string, string][])('a %o refused with %s explains the reason and retains no resend intent', async (action, code, message) => {
  mocks.send.mockResolvedValueOnce(rejected(code));
  const { result, unmount, queryClient } = renderActions();
  await act(() => result.current.run(action));
  expect(result.current).toMatchObject({ message, uncertain: null, busy: false });
  expect(mocks.send).toHaveBeenCalledTimes(1);
  unmount(); queryClient.clear();
});

test.each([
  [new ApiError('Too many social actions.', 'http', 429, 'social_limit', 30), 'social.rate_limited'],
  [new ApiError('Social participation is disabled.', 'http', 503, 'social_disabled'), 'social.unavailable'],
  [new ApiError('Bad request.', 'http', 400, 'invalid_request'), 'social.error']
])('a definite failed request (%s) is explained without offering outcome recovery', async (error, message) => {
  mocks.send.mockRejectedValueOnce(error);
  const { result, unmount, queryClient } = renderActions();
  await act(() => result.current.run({ action: 'request', targetSocialId: target, expectedRevision: 0 }));
  expect(result.current).toMatchObject({ message, uncertain: null, busy: false });
  unmount(); queryClient.clear();
});

test('a rate-limited scope request is explained before any command exists', async () => {
  mocks.prepare.mockRejectedValueOnce(new ApiError('Too many scopes.', 'http', 429, 'social_limit'));
  const { result, unmount, queryClient } = renderActions();
  await act(() => result.current.run({ action: 'block', targetSocialId: target }));
  expect(result.current).toMatchObject({ message: 'social.rate_limited', uncertain: null });
  expect(mocks.send).not.toHaveBeenCalled();
  unmount(); queryClient.clear();
});

test('a recovered rejected outcome is explained for the original uncertain gesture', async () => {
  mocks.send.mockRejectedValueOnce(new ApiError('Acknowledgement lost.', 'network'));
  const { result, unmount, queryClient } = renderActions();
  await act(() => result.current.run({ action: 'block', targetSocialId: target }));
  expect(result.current).toMatchObject({ message: 'social.unknown', uncertain: expect.objectContaining({ action: 'block' }) });
  mocks.outcome.mockResolvedValueOnce({ outcome: { ...rejected('social_limit'), replayed: true } });
  await act(() => result.current.check());
  expect(mocks.outcome).toHaveBeenCalledExactlyOnceWith('alice', expect.objectContaining({ action: 'block', commandId: 'captured-command-01' }));
  expect(result.current).toMatchObject({ message: 'social.block_limit', uncertain: null });
  expect(mocks.send).toHaveBeenCalledTimes(1);
  unmount(); queryClient.clear();
});
