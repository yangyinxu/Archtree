import { ApiError } from '../../api/client';

const mocks = vi.hoisted(() => ({ getCurrentRoom: vi.fn(), prepareRoomCommand: vi.fn(), sendRoomCommand: vi.fn() }));
vi.mock('../../api/rooms', async importOriginal => ({ ...await importOriginal<typeof import('../../api/rooms')>(),
  getCurrentRoom: mocks.getCurrentRoom, getRealtimeTicket: vi.fn(),
  prepareRoomCommand: mocks.prepareRoomCommand, sendRoomCommand: mocks.sendRoomCommand }));
vi.mock('../../player', () => ({ playerStore: { attachRoomPlayback: vi.fn(), notePlaybackIntent: vi.fn() } }));
// Simulates a refusal-copy chunk that cannot be fetched, e.g. after a deployment replaced the assets.
vi.mock('./socialRefusal', () => { throw new Error('Failed to fetch dynamically imported module'); });
import { roomSession } from './roomSession';

const decline = { action: 'declineInvitation' as const, invitationId: 'invitation-a', generation: 1 };
beforeEach(() => {
  roomSession.stop(); vi.clearAllMocks();
  mocks.getCurrentRoom.mockResolvedValue({ room: null });
  mocks.prepareRoomCommand.mockImplementation(async (_viewer, action) => ({ ...action, commandId: 'immutable-command-123', scopeToken: 'original-scope-token-123' }));
  // Declining needs no realtime connection, so the transport stays off for this boundary test.
  roomSession.ensure('viewer-1', vi.fn(), { realtimeEnabled: false });
});
afterEach(() => roomSession.stop());

test('a definite rejection stays definite when its specific copy cannot load', async () => {
  mocks.sendRoomCommand.mockResolvedValueOnce({ commandId: 'immutable-command-123', outcome: 'rejected', code: 'invitation_unavailable', replayed: false });
  await roomSession.run(decline);
  expect(roomSession.getSnapshot()).toMatchObject({ error: 'social.error', uncertain: null, busy: false });
});

test('a definite failed request stays definite when its specific copy cannot load', async () => {
  mocks.sendRoomCommand.mockRejectedValueOnce(new ApiError('Too many social actions.', 'http', 429, 'social_limit'));
  await roomSession.run(decline);
  expect(roomSession.getSnapshot()).toMatchObject({ error: 'social.error', uncertain: null, busy: false });
  expect(mocks.sendRoomCommand).toHaveBeenCalledTimes(1);
});
