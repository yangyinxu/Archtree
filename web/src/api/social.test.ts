import { advanceAccountEpoch } from './accountEpoch';
import { getSocialProfile, getSocialRelationship, getSocialOutcome, prepareSocialCommand, sendSocialCommand,
  socialCardSchema, socialProfileSchema, socialPageSchema, socialOutcomeSchema } from './social';

const profile = { socialId: `s_${'a'.repeat(32)}`, handle: 'alice', alias: 'Alice', iconSeed: 'alice', active: true, discoverable: true, revision: 1 };
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json', 'X-Finitude-Account-Viewer': 'viewer-1' }
});
beforeEach(() => advanceAccountEpoch());

test('social projections reject private additions and retain null blocked profiles', () => {
  expect(socialProfileSchema.safeParse(profile).success).toBe(true);
  expect(socialProfileSchema.safeParse({ ...profile, email: 'private@example.invalid' }).success).toBe(false);
  expect(socialCardSchema.safeParse({ ...profile }).success).toBe(false);
  expect(socialPageSchema.safeParse({ items: [{ socialId: profile.socialId, revision: 2, profile: null }], nextCursor: null }).success).toBe(true);
  expect(socialOutcomeSchema.safeParse({ commandId: crypto.randomUUID(), outcome: 'applied', replayed: true, profile }).success).toBe(false);
});

test('account-bound social commands preserve one captured scope and key on explicit retry', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(reply({ scopeToken: 'synthetic-scope-token-123', expiresAt: new Date(Date.now() + 60_000).toISOString() }));
  vi.stubGlobal('fetch', fetcher);
  const action = { action: 'request' as const, targetSocialId: profile.socialId, expectedRevision: 2 };
  const pending = prepareSocialCommand('viewer-1', action);
  action.expectedRevision = 9;
  const command = await pending;
  expect('expectedRevision' in command && command.expectedRevision).toBe(2);
  fetcher.mockRejectedValueOnce(new TypeError('Network failed'));
  await expect(sendSocialCommand('viewer-1', command)).rejects.toMatchObject({ kind: 'network' });
  expect(fetcher).toHaveBeenCalledTimes(2);
  const original = JSON.parse(fetcher.mock.calls[1][1].body);
  fetcher.mockResolvedValueOnce(reply({ commandId: command.commandId, outcome: 'applied', replayed: true }));
  await sendSocialCommand('viewer-1', command);
  expect(JSON.parse(fetcher.mock.calls[2][1].body)).toEqual(original);
  expect(fetcher.mock.calls[2][0]).toBe('/api/social/v1/friend-requests');
  expect(new Headers(fetcher.mock.calls[2][1].headers).get('X-Finitude-Account-Viewer')).toBe('viewer-1');
});

test('relationship reads obtain public preconditions and outcome lookup sends no command body', async () => {
  const command = { scopeToken: 'synthetic-scope-token-123', commandId: crypto.randomUUID() };
  const fetcher = vi.fn().mockResolvedValueOnce(reply({ relationship: { socialId: profile.socialId, state: 'none', revision: 7 } }))
    .mockResolvedValueOnce(reply({ outcome: null }));
  vi.stubGlobal('fetch', fetcher);
  expect((await getSocialRelationship('viewer-1', profile.socialId)).relationship?.revision).toBe(7);
  expect((await getSocialOutcome('viewer-1', command)).outcome).toBeNull();
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual(command);
});

test('a response for a different account cannot populate social state', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ profile }), {
    headers: { 'Content-Type': 'application/json', 'X-Finitude-Account-Viewer': 'viewer-2' }
  })));
  await expect(getSocialProfile('viewer-1')).rejects.toMatchObject({ code: 'account_viewer_mismatch' });
});

test('listening preference and explicit publisher claims use immutable social receipts and their dedicated routes', async () => {
  const identity = { scopeToken: 'synthetic-signed-scope-token', commandId: 'synthetic-command-01' };
  const fetcher = vi.fn().mockImplementation(async () => reply({ commandId: identity.commandId, outcome: 'applied', replayed: false }));
  vi.stubGlobal('fetch', fetcher);
  await sendSocialCommand('viewer-1', { ...identity, action: 'setListeningSharing', enabled: false, expectedRevision: 2 });
  expect(fetcher.mock.calls[0][0]).toBe('/api/social/v1/me/listening');
  expect(fetcher.mock.calls[0][1].method).toBe('PATCH');
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ ...identity, enabled: false, expectedRevision: 2 });
  await sendSocialCommand('viewer-1', { ...identity, action: 'claimListening', clientId: 'synthetic-client-01', expectedPreferenceRevision: 3, expectedPublisherRevision: 4 });
  expect(fetcher.mock.calls[1][0]).toBe('/api/social/v1/listening-publications/claim');
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ ...identity, clientId: 'synthetic-client-01', expectedPreferenceRevision: 3, expectedPublisherRevision: 4 });
});

test.each(['audioTrack', 'album'] as const)('music sharing sends only the captured %s reference and friendship precondition', async contentType => {
  const fetcher = vi.fn().mockResolvedValue(reply({ commandId: 'synthetic-command-01', outcome: 'applied', replayed: false }));
  vi.stubGlobal('fetch', fetcher);
  const command = { action: 'shareMusic' as const, contentType, contentId: 'a'.repeat(24), targetSocialId: profile.socialId,
    expectedRevision: 2, scopeToken: 'synthetic-signed-scope-token', commandId: 'synthetic-command-01' };
  await sendSocialCommand('viewer-1', command);
  expect(fetcher.mock.calls[0][0]).toBe('/api/social/v1/music-shares');
  const { action: _action, ...body } = command;
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual(body);
});

test.each([['dismissMusicShare', 'dismiss'], ['withdrawMusicShare', 'withdraw']] as const)('%s addresses the exact share incarnation with identity-only JSON', async (action, path) => {
  const fetcher = vi.fn().mockResolvedValue(reply({ commandId: 'synthetic-command-01', outcome: 'applied', replayed: false }));
  vi.stubGlobal('fetch', fetcher);
  const identity = { scopeToken: 'synthetic-signed-scope-token', commandId: 'synthetic-command-01' };
  const shareId = `ms_${'b'.repeat(32)}`;
  await sendSocialCommand('viewer-1', { action, shareId, ...identity });
  expect(fetcher.mock.calls[0][0]).toBe(`/api/social/v1/music-shares/${shareId}/${path}`);
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual(identity);
  expect(() => sendSocialCommand('viewer-1', { action, shareId: '../other', ...identity })).toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
