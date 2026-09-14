import { advanceAccountEpoch } from '../../api/accountEpoch';
import { ApiError } from '../../api/client';
import type { SocialCommand } from '../../api/social';

const mocks = vi.hoisted(() => ({ prepare: vi.fn(), send: vi.fn(), outcome: vi.fn() }));
vi.mock('../../api/social', () => ({ prepareSocialCommand: mocks.prepare, sendSocialCommand: mocks.send, getSocialOutcome: mocks.outcome }));
import { createMusicShareSession } from './musicShareSession';

const action = { action: 'shareMusic' as const, targetSocialId: `s_${'a'.repeat(32)}`, expectedRevision: 2,
  contentType: 'audioTrack' as const, contentId: 'b'.repeat(24) };
const command: SocialCommand = Object.freeze({ ...action, scopeToken: 'captured-scope-token', commandId: 'captured-command-01' });
const applied = { commandId: command.commandId, outcome: 'applied' as const, replayed: false };
/** Holds one boundary so account switches and duplicate clicks are deterministic. */
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
beforeEach(() => {
  advanceAccountEpoch(); vi.clearAllMocks();
  mocks.prepare.mockResolvedValue(command); mocks.send.mockResolvedValue(applied);
  mocks.outcome.mockResolvedValue({ outcome: null });
});

test('synchronous locking sends one immutable intent for simultaneous clicks', async () => {
  const scope = deferred<SocialCommand>(); mocks.prepare.mockReturnValue(scope.promise);
  const session = createMusicShareSession(); const refresh = vi.fn(); session.ensure('alice', refresh);
  const first = session.run(action); await session.run(action);
  expect(mocks.prepare).toHaveBeenCalledTimes(1); expect(session.getSnapshot().busy).toBe(true);
  scope.resolve(command); await first;
  expect(mocks.send).toHaveBeenCalledExactlyOnceWith('alice', command);
  expect(refresh).toHaveBeenCalledTimes(1); expect(session.getSnapshot()).toMatchObject({ busy: false, uncertain: null, message: 'social.updated' });
});

test('an account change while preparing a scope prevents dispatch', async () => {
  const scope = deferred<SocialCommand>(); mocks.prepare.mockReturnValue(scope.promise);
  const session = createMusicShareSession(); session.ensure('alice', vi.fn());
  const pending = session.run(action); advanceAccountEpoch(); session.ensure('bob', vi.fn());
  scope.resolve(command); await pending;
  expect(mocks.send).not.toHaveBeenCalled();
  expect(session.getSnapshot()).toMatchObject({ viewerId: 'bob', busy: false, uncertain: null, message: null });
});

test('closing and reopening retains an uncertain command, blocks new intents, and retries the same key', async () => {
  mocks.send.mockRejectedValueOnce(new TypeError('disconnected'));
  const session = createMusicShareSession(); session.ensure('alice', vi.fn()); await session.run(action);
  expect(session.getSnapshot().uncertain).toBe(command);
  const newRefresh = vi.fn(); session.ensure('alice', newRefresh);
  await session.run({ ...action, contentId: 'c'.repeat(24) });
  expect(mocks.send).toHaveBeenCalledTimes(1);
  await session.retry();
  expect(mocks.prepare).toHaveBeenCalledTimes(1);
  expect(mocks.send.mock.calls[1]).toEqual(['alice', command]);
  expect(newRefresh).toHaveBeenCalledTimes(1);
  expect(session.getSnapshot().uncertain).toBeNull();
});

test('checking an unknown outcome never resends and clears only on a recorded outcome', async () => {
  mocks.send.mockRejectedValueOnce(new TypeError('disconnected'));
  const session = createMusicShareSession(); session.ensure('alice', vi.fn()); await session.run(action);
  await session.check(); expect(session.getSnapshot().uncertain).toBe(command);
  mocks.outcome.mockResolvedValueOnce({ outcome: { ...applied, replayed: true } }); await session.check();
  expect(mocks.outcome).toHaveBeenLastCalledWith('alice', command);
  expect(mocks.send).toHaveBeenCalledTimes(1); expect(session.getSnapshot().uncertain).toBeNull();
});

test.each(['success', 'failure'])('late %s cannot update the replacement account', async kind => {
  const response = deferred<typeof applied>(); mocks.send.mockReturnValue(response.promise);
  const session = createMusicShareSession(); const aliceRefresh = vi.fn(); const bobRefresh = vi.fn();
  session.ensure('alice', aliceRefresh); const pending = session.run(action); await Promise.resolve();
  advanceAccountEpoch(); session.ensure('bob', bobRefresh);
  if (kind === 'success') response.resolve(applied); else response.reject(new TypeError('old error'));
  await pending;
  expect(aliceRefresh).not.toHaveBeenCalled(); expect(bobRefresh).not.toHaveBeenCalled();
  expect(session.getSnapshot()).toMatchObject({ viewerId: 'bob', message: null, uncertain: null, busy: false });
});

test('a definite rejection and a preparation failure do not retain a resend intent', async () => {
  const session = createMusicShareSession(); session.ensure('alice', vi.fn());
  mocks.send.mockRejectedValueOnce(new ApiError('Forbidden', 'http', 403));
  await session.run(action); expect(session.getSnapshot().uncertain).toBeNull();
  mocks.prepare.mockRejectedValueOnce(new TypeError('scope unavailable'));
  await session.run(action); expect(session.getSnapshot().uncertain).toBeNull();
  expect(mocks.send).toHaveBeenCalledTimes(1);
});

test('a failed refresh cannot reclassify an acknowledged write as uncertain', async () => {
  const session = createMusicShareSession(); session.ensure('alice', async () => { throw new Error('read failed'); });
  await session.run(action);
  expect(session.getSnapshot()).toMatchObject({ uncertain: null, message: 'social.updated', busy: false });
});

test.each([['music_unavailable', 'music_shares.unavailable'], ['music_share_capacity', 'music_shares.limit'],
  ['music_share_limit', 'music_shares.limit'], ['relationship_changed', 'social.stale']])('a recorded %s rejection gives an actionable message without retaining the command', async (code, message) => {
  mocks.send.mockResolvedValueOnce({ ...applied, outcome: 'rejected', code });
  const session = createMusicShareSession(); session.ensure('alice', vi.fn()); await session.run(action);
  expect(session.getSnapshot()).toMatchObject({ uncertain: null, busy: false, message });
});
