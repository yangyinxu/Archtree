import type { RoomSnapshot } from '../api/rooms';

/** Synthetic public-only room used by wire, transport and page tests. */
export const roomFixture = (): RoomSnapshot => ({
  protocolVersion: 1, roomId: 'room-a', epoch: 1, revision: 1, serverTimeMs: 1_000_000,
  status: 'open', controlMode: 'everyone', controlGeneration: 1, hostMemberId: 'member-a', hostAbsenceDeadlineMs: null,
  queueRevision: 1, queue: [{ entryId: 'entry-a', mediaTrackId: '000000000000000000000001',
    title: 'Quiet interval', mediaRevision: 'revision-a', durationMs: 30_000, mediaType: 'Audio',
    streamUrl: '/content/mediaTrack/stream/000000000000000000000001?revision=revision-a' }],
  timeline: { playbackGeneration: 1, entryId: 'entry-a', mediaRevision: 'revision-a', durationMs: 30_000,
    state: 'preparing', positionMs: 0, anchorServerTimeMs: 1_000_000 },
  preparation: { preparationId: 'prepare-a', playbackGeneration: 1, entryId: 'entry-a', mediaRevision: 'revision-a',
    targetPositionMs: 0, deadlineServerTimeMs: 1_003_000, cohortMembershipIds: ['member-a'] },
  members: [{ socialId: `s_${'a'.repeat(32)}`, handle: 'alice', alias: 'Alice', iconSeed: 'alice',
    memberId: 'member-a', role: 'host', controllerGeneration: 1, connected: true, ready: false }],
  self: { memberId: 'member-a', controllerGeneration: 1, isController: true, canControl: true }, transferOffer: null
});
