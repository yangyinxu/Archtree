import { roomFixture } from '../test/roomFixture';
import { advanceAccountEpoch } from './accountEpoch';
import { getCurrentRoom, getOutgoingRoomInvitations, getRoomCapabilities, getRoomInvitation, roomClientId,
  roomInvitationSchema, roomOutgoingInvitationSchema, roomSnapshotSchema, sendRoomCommand } from './rooms';

beforeEach(() => advanceAccountEpoch());

test('room snapshots reject private fields, unpinned timeline mismatches and unsafe media URLs', () => {
  const room = roomFixture();
  expect(roomSnapshotSchema.safeParse(room).success).toBe(true);
  expect(roomSnapshotSchema.safeParse({ ...room, accountId: 'private' }).success).toBe(false);
  expect(roomSnapshotSchema.safeParse({ ...room, timeline: { ...room.timeline, mediaRevision: 'wrong' } }).success).toBe(false);
  expect(roomSnapshotSchema.safeParse({ ...room, queue: [{ ...room.queue[0], streamUrl: 'https://unknown.invalid/media' }] }).success).toBe(false);
  expect(roomSnapshotSchema.safeParse({ ...room, queue: [room.queue[0], room.queue[0]] }).success).toBe(false);
});

test('room HTTP requests are fenced to the current account and one tab identity', async () => {
  const command = { action: 'end' as const, scopeToken: 'synthetic-scope-token-123', commandId: crypto.randomUUID(), roomId: 'room-a', memberId: 'member-a' };
  const response = (value: unknown) => new Response(JSON.stringify(value), { headers: {
    'Content-Type': 'application/json', 'X-Finitude-Account-Viewer': 'viewer-1'
  } });
  const fetcher = vi.fn().mockResolvedValueOnce(response({ room: roomFixture() })).mockResolvedValueOnce(response({
    commandId: command.commandId, outcome: 'applied', replayed: false
  }));
  vi.stubGlobal('fetch', fetcher);
  await getCurrentRoom('viewer-1'); await sendRoomCommand('viewer-1', command);
  for (const [, options] of fetcher.mock.calls) {
    expect(new Headers(options.headers).get('X-Finitude-Room-Client')).toBe(roomClientId());
    expect(new Headers(options.headers).get('X-Finitude-Account-Viewer')).toBe('viewer-1');
  }
  expect(fetcher.mock.calls[1][0]).toBe('/api/social/v1/room-commands');
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual(command);
});

const invitation = { invitationId: 'i_invitation', generation: 2, expiresAtMs: Date.now() + 60_000,
  inviter: { socialId: `s_${'a'.repeat(32)}`, handle: 'alice', alias: 'Alice', iconSeed: 'alice' } };
const outgoing = { invitationId: invitation.invitationId, generation: invitation.generation,
  recipientSocialId: `s_${'b'.repeat(32)}`, expiresAtMs: invitation.expiresAtMs };
const reply = (value: unknown, viewer = 'viewer-1') => new Response(JSON.stringify(value), { headers: {
  'Content-Type': 'application/json', 'X-Finitude-Account-Viewer': viewer
} });

test('invitation detail, outgoing metadata and capabilities use strict account-bound reads', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(reply({ invitation })).mockResolvedValueOnce(reply({ invitations: [outgoing] }))
    .mockResolvedValueOnce(reply({ socialEnabled: true, roomsEnabled: true })).mockResolvedValueOnce(reply({ invitation: null }));
  vi.stubGlobal('fetch', fetcher);
  expect(await getRoomInvitation('viewer-1', invitation.invitationId)).toEqual({ invitation });
  expect(await getOutgoingRoomInvitations('viewer-1', 'r_room')).toEqual({ invitations: [outgoing] });
  expect(await getRoomCapabilities('viewer-1')).toEqual({ socialEnabled: true, roomsEnabled: true });
  expect(await getRoomInvitation('viewer-1', 'i_missing')).toEqual({ invitation: null });
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['/api/social/v1/room-invitations/i_invitation',
    '/api/social/v1/rooms/r_room/invitations', '/api/social/v1/capabilities', '/api/social/v1/room-invitations/i_missing']);
  for (const [, options] of fetcher.mock.calls) {
    expect(new Headers(options.headers).get('X-Finitude-Room-Client')).toBe(roomClientId());
    expect(new Headers(options.headers).get('X-Finitude-Account-Viewer')).toBe('viewer-1');
    expect(options.body).toBeUndefined();
  }
});

test('invitation projections reject room access, private recipient fields and malformed generations', () => {
  expect(roomInvitationSchema.safeParse(invitation).success).toBe(true);
  expect(roomOutgoingInvitationSchema.safeParse(outgoing).success).toBe(true);
  for (const extra of [{ roomId: 'r_private' }, { queue: [] }, { members: [] }, { generation: 0 }]) {
    expect(roomInvitationSchema.safeParse({ ...invitation, ...extra }).success).toBe(false);
  }
  for (const extra of [{ recipientAccountId: 'private' }, { recipient: invitation.inviter }, { generation: 1.5 }]) {
    expect(roomOutgoingInvitationSchema.safeParse({ ...outgoing, ...extra }).success).toBe(false);
  }
});

test('invitation reads reject another account, unsafe identifiers and canceled navigation', async () => {
  const fetcher = vi.fn().mockResolvedValue(reply({ invitation }, 'viewer-2'));
  vi.stubGlobal('fetch', fetcher);
  await expect(getRoomInvitation('viewer-1', invitation.invitationId)).rejects.toMatchObject({ code: 'account_viewer_mismatch' });
  expect(() => getRoomInvitation('viewer-1', '../rooms/current')).toThrow();
  expect(() => getOutgoingRoomInvitations('viewer-1', 'r_room?account=other')).toThrow();
  const controller = new AbortController(); controller.abort();
  await expect(getRoomCapabilities('viewer-1', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test('capabilities reject unknown fields instead of accepting an expanded private response', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply({ socialEnabled: true, roomsEnabled: true, privateFlag: true })));
  await expect(getRoomCapabilities('viewer-1')).rejects.toMatchObject({ kind: 'invalid-response' });
});
