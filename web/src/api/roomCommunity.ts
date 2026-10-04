import { z } from 'zod';
import { ROOM_REACTIONS, type RoomCommunity, type RoomCommunityEvent } from '../../../src/contracts/roomV1';
import { roomClientId } from './rooms';
import { socialCardSchema, socialRevisionSchema } from './socialSchemas';
import { socialReadRequest } from './socialReadRequest';

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/).refine(value => !/\s/.test(value));
const positive = socialRevisionSchema.refine(value => value > 0);

/** Only confirmed bounded room notices are accepted; automatic advancement is the sole actorless event. */
export const roomCommunityEventSchema = z.object({ eventId: identifier,
  kind: z.enum(['joined', 'trackChanged', 'hostChanged', 'modeChanged', 'reaction']),
  actor: socialCardSchema.nullable(), reaction: z.enum(ROOM_REACTIONS).nullable(),
  createdAtMs: socialRevisionSchema, expiresAtMs: socialRevisionSchema
}).strict().refine(event => event.expiresAtMs > event.createdAtMs && event.expiresAtMs - event.createdAtMs <= 30_000
  && (event.actor !== null || event.kind === 'trackChanged')
  && (event.kind === 'reaction' ? event.reaction !== null : event.reaction === null), 'Invalid room event.') satisfies z.ZodType<RoomCommunityEvent>;

/** Community metadata stays separate from the strict playback snapshot and exposes public cards only. */
export const roomCommunitySchema = z.object({
  roomId: identifier, epoch: positive, revision: positive,
  requests: z.array(z.object({ requestId: identifier, mediaTrackId: z.string().regex(/^[a-f0-9]{24}$/),
    title: z.string().min(1).max(500), requestedBy: socialCardSchema, createdAtMs: socialRevisionSchema }).strict()).max(20),
  queueCredits: z.array(z.object({ entryId: identifier, requestedBy: socialCardSchema.nullable() }).strict()).max(100),
  events: z.array(roomCommunityEventSchema).max(20)
}).strict().superRefine((community, context) => {
  if (new Set(community.requests.map(request => request.requestId)).size !== community.requests.length
    || new Set(community.queueCredits.map(credit => credit.entryId)).size !== community.queueCredits.length
    || new Set(community.events.map(event => event.eventId)).size !== community.events.length) {
    context.addIssue({ code: 'custom', message: 'Room requests and queue credits must have unique identities.' });
  }
}) satisfies z.ZodType<RoomCommunity>;

/** The requested room and account must both match before metadata enters a private query cache. */
export const getRoomCommunity = (viewerId: string, roomId: string, signal?: AbortSignal) => {
  const requestedRoom = identifier.parse(roomId);
  return socialReadRequest(`/api/social/v1/rooms/${encodeURIComponent(requestedRoom)}/community`,
    z.object({ community: roomCommunitySchema }).strict().refine(value => value.community.roomId === requestedRoom,
      'Room community must belong to the requested room.'),
    { accountViewer: viewerId, headers: { 'X-Finitude-Room-Client': roomClientId() }, signal });
};

export type { RoomCommunity, RoomCommunityEvent };
