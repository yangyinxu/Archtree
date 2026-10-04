import { advanceAccountEpoch } from './accountEpoch';
import { getSocialChangeRevision } from './socialChanges';

const reply = (value: unknown, viewer = 'viewer-1') => new Response(JSON.stringify(value), {
  headers: { 'Content-Type': 'application/json', 'X-Finitude-Account-Viewer': viewer }
});
beforeEach(() => advanceAccountEpoch());

test('the change cursor is an account-bound read of one opaque revision', async () => {
  const fetcher = vi.fn().mockResolvedValue(reply({ revision: 12 }));
  vi.stubGlobal('fetch', fetcher);
  expect(await getSocialChangeRevision('viewer-1')).toEqual({ revision: 12 });
  expect(fetcher.mock.calls[0][0]).toBe('/api/social/v1/me/changes');
  expect(fetcher.mock.calls[0][1].method ?? 'GET').toBe('GET');
  expect(fetcher.mock.calls[0][1].body).toBeUndefined();
  expect(new Headers(fetcher.mock.calls[0][1].headers).get('X-Finitude-Account-Viewer')).toBe('viewer-1');
});

test.each([
  ['an added field', { revision: 1, accountId: 'private-account' }],
  ['a negative counter', { revision: -1 }],
  ['a fractional counter', { revision: 1.5 }],
  ['a missing counter', {}]
])('the change cursor rejects %s', async (_name, body) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(body)));
  await expect(getSocialChangeRevision('viewer-1')).rejects.toMatchObject({ kind: 'invalid-response' });
});

test('a change cursor answered for another account is rejected', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply({ revision: 3 }, 'viewer-2')));
  await expect(getSocialChangeRevision('viewer-1')).rejects.toMatchObject({ code: 'account_viewer_mismatch' });
});
