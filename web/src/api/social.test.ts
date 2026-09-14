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
