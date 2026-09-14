import { z } from 'zod';
import type { RoomCommand, RoomReadyReport, RoomHeartbeat } from '../../../src/contracts/roomV1';
import { apiRequest } from './client';
import { socialReadRequest } from './socialReadRequest';
import { socialCardSchema, socialOutcomeSchema, socialRevisionSchema } from './socialSchemas';

const base = '/api/social/v1';
const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const positive = socialRevisionSchema.refine(value => value > 0);
const millis = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const roomMediaSchema = z.object({
  mediaTrackId: z.string().regex(/^[a-f0-9]{24}$/), title: z.string().min(1).max(500), mediaRevision: identifier,
  durationMs: millis.refine(value => value > 0 && value <= 86_400_000),
  streamUrl: z.string().max(2048),
  mediaType: z.literal('Audio')
}).strict().refine(value => value.streamUrl === `/content/mediaTrack/stream/${value.mediaTrackId}?revision=${value.mediaRevision}`,
  'Room media must use its exact same-origin identity and pinned revision.');
export const roomSnapshotSchema = z.object({
  protocolVersion: z.literal(1), roomId: identifier, epoch: positive, revision: positive, serverTimeMs: millis,
  status: z.enum(['open', 'suspended', 'ended']), controlMode: z.enum(['hostOnly', 'everyone']), controlGeneration: positive,
  hostMemberId: identifier, hostAbsenceDeadlineMs: millis.nullable(), queueRevision: positive,
  queue: z.array(roomMediaSchema.safeExtend({ entryId: identifier }).strict()).min(1).max(100),
  timeline: z.object({ playbackGeneration: positive, entryId: identifier, mediaRevision: identifier,
    durationMs: millis, state: z.enum(['preparing', 'paused', 'playing', 'ended']), positionMs: millis, anchorServerTimeMs: millis }).strict().nullable(),
  preparation: z.object({ preparationId: identifier, playbackGeneration: positive, entryId: identifier,
    mediaRevision: identifier, targetPositionMs: millis, deadlineServerTimeMs: millis, cohortMembershipIds: z.array(identifier).max(8) }).strict().nullable(),
  members: z.array(socialCardSchema.extend({ memberId: identifier, role: z.enum(['host', 'guest']),
    controllerGeneration: positive, connected: z.boolean(), ready: z.boolean() }).strict()).max(8),
  self: z.object({ memberId: identifier, controllerGeneration: positive, isController: z.boolean(), canControl: z.boolean() }).strict(),
  transferOffer: z.object({ offerId: identifier, targetMemberId: identifier, targetControllerGeneration: positive, expiresAtMs: millis }).strict().nullable()
}).strict().superRefine((room, context) => {
  if (new Set(room.queue.map(entry => entry.entryId)).size !== room.queue.length
    || new Set(room.members.map(member => member.memberId)).size !== room.members.length) {
    context.addIssue({ code: 'custom', message: 'Room entries and memberships must be unique.' });
  }
  const entry = room.queue.find(item => item.entryId === room.timeline?.entryId);
  if (room.timeline && (!entry || entry.mediaRevision !== room.timeline.mediaRevision
    || entry.durationMs !== room.timeline.durationMs || room.timeline.positionMs > entry.durationMs)) {
    context.addIssue({ code: 'custom', message: 'The timeline must match its pinned queue entry.' });
  }
});
export const roomInvitationSchema = z.object({ invitationId: identifier, generation: positive,
  inviter: socialCardSchema, expiresAtMs: millis }).strict();
export const roomOutgoingInvitationSchema = z.object({ invitationId: identifier, generation: positive,
  recipientSocialId: socialCardSchema.shape.socialId, expiresAtMs: millis }).strict();
export type RoomSnapshot = z.infer<typeof roomSnapshotSchema>;
export type RoomMedia = z.infer<typeof roomMediaSchema>;
export type RoomInvitation = z.infer<typeof roomInvitationSchema>;
export type RoomOutgoingInvitation = z.infer<typeof roomOutgoingInvitationSchema>;
export type { RoomCommand, RoomHeartbeat, RoomReadyReport };
export type RoomAction = RoomCommand extends infer C ? C extends RoomCommand ? Omit<C, 'scopeToken' | 'commandId'> : never : never;

let clientId: string | undefined;
/** A fresh document cannot inherit the controller identity copied by Duplicate Tab. */
export const roomClientId = () => {
  if (clientId) return clientId;
  clientId = crypto.randomUUID();
  return clientId;
};
const options = (viewerId: string) => ({ accountViewer: viewerId, headers: { 'X-Finitude-Room-Client': roomClientId() } });
export const getCurrentRoom = (viewerId: string) => socialReadRequest(`${base}/rooms/current`, z.object({ room: roomSnapshotSchema.nullable() }).strict(), options(viewerId));
export const getRoomInvitations = (viewerId: string, signal?: AbortSignal) => socialReadRequest(`${base}/room-invitations`, z.object({ invitations: z.array(roomInvitationSchema).max(20) }).strict(), { ...options(viewerId), signal });
export const getRoomInvitation = (viewerId: string, invitationId: string, signal?: AbortSignal) => socialReadRequest(`${base}/room-invitations/${encodeURIComponent(identifier.parse(invitationId))}`, z.object({ invitation: roomInvitationSchema.nullable() }).strict(), { ...options(viewerId), signal });
export const getOutgoingRoomInvitations = (viewerId: string, roomId: string, signal?: AbortSignal) => socialReadRequest(`${base}/rooms/${encodeURIComponent(identifier.parse(roomId))}/invitations`, z.object({ invitations: z.array(roomOutgoingInvitationSchema).max(20) }).strict(), { ...options(viewerId), signal });
export const getRoomCapabilities = (viewerId: string, signal?: AbortSignal) => socialReadRequest(`${base}/capabilities`, z.object({ socialEnabled: z.boolean(), roomsEnabled: z.boolean() }).strict(), { ...options(viewerId), signal });
export const getRoomMedia = (viewerId: string, signal?: AbortSignal) => socialReadRequest(`${base}/room-media`, z.object({ items: z.array(roomMediaSchema).max(100) }).strict(), { ...options(viewerId), signal });
export const prepareRoomCommand = async (viewerId: string, action: RoomAction): Promise<RoomCommand> => {
  const captured = { ...action, ...('mediaTrackIds' in action ? { mediaTrackIds: [...action.mediaTrackIds] } : {}) };
  const { prepareMutationIdentity } = await import('./social');
  return Object.freeze({ ...captured, ...await prepareMutationIdentity(viewerId) }) as RoomCommand;
};
export const sendRoomCommand = (viewerId: string, command: RoomCommand) => apiRequest(`${base}/room-commands`, socialOutcomeSchema, {
  ...options(viewerId), method: 'POST', body: JSON.stringify(command)
});
export const getRealtimeTicket = (viewerId: string) => apiRequest(`${base}/realtime-tickets`, z.object({
  ticket: z.string().min(16).max(1024), expiresAt: z.string().datetime()
}).strict(), { ...options(viewerId), method: 'POST', body: JSON.stringify({ clientId: roomClientId() }) });
export const roomControlPreconditions = (room: RoomSnapshot) => ({ roomId: room.roomId, memberId: room.self.memberId,
  expectedEpoch: room.epoch, controllerGeneration: room.self.controllerGeneration, expectedControlGeneration: room.controlGeneration,
  expectedPlaybackGeneration: room.timeline!.playbackGeneration, expectedQueueRevision: room.queueRevision, expectedEntryId: room.timeline!.entryId });
