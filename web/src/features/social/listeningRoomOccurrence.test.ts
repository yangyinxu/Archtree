import { roomFixture } from '../../test/roomFixture';
import { listeningRoomOccurrence } from './listeningRoomOccurrence';
const mocks = vi.hoisted(() => ({ state: {} as any }));
vi.mock('./roomSession', () => ({ roomSession: { getSnapshot: () => mocks.state } }));
const sample = () => ({ intentId: 1, sourceId: 'source-001', occurrenceId: 'occur-001', mediaTrackId: '000000000000000000000001', positionMs: 10, observedAtMs: 0,
  room: { roomId: 'room-a', epoch: 1, playbackEpoch: 1, entryId: 'entry-a', mediaRevision: 'revision-a' } });
beforeEach(() => { const room = roomFixture(); room.timeline!.state = 'playing'; room.members[0].ready = true;
  mocks.state = { viewerId: 'alice', connected: true, locallyPaused: false, room }; });
test('only the exact ready room controller enriches observed playback with current private membership', () => {
  expect(listeningRoomOccurrence('alice', sample())).toEqual({ roomId: 'room-a', epoch: 1, memberId: 'member-a', controllerGeneration: 1, playbackGeneration: 1, entryId: 'entry-a', mediaRevision: 'revision-a' });
});
test.each(['viewer', 'offline', 'localpause', 'observer', 'notready', 'paused', 'epoch', 'generation', 'entry', 'revision'])('%s room changes deny the old observation', kind => {
  const room = mocks.state.room;
  if (kind === 'viewer') mocks.state.viewerId = 'bob'; if (kind === 'offline') mocks.state.connected = false;
  if (kind === 'localpause') mocks.state.locallyPaused = true; if (kind === 'observer') room.self.isController = false;
  if (kind === 'notready') room.members[0].ready = false; if (kind === 'paused') room.timeline.state = 'paused';
  if (kind === 'epoch') room.epoch++; if (kind === 'generation') room.timeline.playbackGeneration++;
  if (kind === 'entry') room.timeline.entryId = 'other'; if (kind === 'revision') room.timeline.mediaRevision = 'other';
  expect(listeningRoomOccurrence('alice', sample())).toBeUndefined();
});
