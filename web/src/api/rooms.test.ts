import { roomFixture } from '../test/roomFixture';
import { getCurrentRoom, roomClientId, roomSnapshotSchema, sendRoomCommand } from './rooms';

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
