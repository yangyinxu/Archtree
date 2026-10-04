import type { ListeningSample } from './listeningSession';
import { roomSession } from './roomSession';

/** A report can name room playback only while this document is the exact ready controller. */
export const listeningRoomOccurrence = (viewerId: string, sample: ListeningSample) => {
  if (!sample.room) return null;
  const current = roomSession.getSnapshot(), room = current.room, observed = sample.room;
  if (current.viewerId !== viewerId || !current.connected || current.locallyPaused || !room || room.status !== 'open'
    || !room.self.isController || room.roomId !== observed.roomId || room.epoch !== observed.epoch
    || !room.members.some(member => member.memberId === room.self.memberId && member.ready)
    || room.timeline?.state !== 'playing' || room.timeline.playbackGeneration !== observed.playbackEpoch
    || room.timeline.entryId !== observed.entryId || room.timeline.mediaRevision !== observed.mediaRevision) return undefined;
  return { roomId: room.roomId, epoch: room.epoch, memberId: room.self.memberId,
    controllerGeneration: room.self.controllerGeneration, playbackGeneration: observed.playbackEpoch,
    entryId: observed.entryId, mediaRevision: observed.mediaRevision };
};
