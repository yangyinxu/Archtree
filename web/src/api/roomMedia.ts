import { z } from 'zod';
import { normalizeRoomMediaQuery, ROOM_MEDIA_DISCOVERY_LIMITS } from '../../../src/contracts/roomV1';
import { roomClientId } from './roomClientId';
import { roomMediaSchema } from './rooms';
import { socialReadRequest } from './socialReadRequest';

const base = '/api/social/v1';
const options = (viewerId: string) => ({ accountViewer: viewerId, headers: { 'X-Finitude-Room-Client': roomClientId() } });
const roomMediaCursorSchema = z.string().min(1).max(ROOM_MEDIA_DISCOVERY_LIMITS.cursorBytes).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
export const roomMediaPageSchema = z.object({ items: z.array(roomMediaSchema).max(ROOM_MEDIA_DISCOVERY_LIMITS.maximumPage),
  nextCursor: roomMediaCursorSchema.nullable() }).strict().refine(page => new Set(page.items.map(item => item.mediaTrackId)).size === page.items.length);
/** Searches server-owned eligibility rather than filtering a truncated newest-media preview. */
export const searchRoomMedia = (viewerId: string, input: { query?: string; cursor?: string } = {}, signal?: AbortSignal) => {
  const captured = z.object({ query: z.string().optional(), cursor: roomMediaCursorSchema.optional() }).strict().parse(input);
  const query = normalizeRoomMediaQuery(captured.query); if (query === null) throw new Error('Invalid room media query.');
  const params = new URLSearchParams(); if (query) params.set('q', query); if (captured.cursor) params.set('cursor', captured.cursor);
  return socialReadRequest(`${base}/room-media/search${params.size ? `?${params}` : ''}`, roomMediaPageSchema, { ...options(viewerId), signal });
};
/** Resolves only the exact selected track; unavailable and ineligible media share the same empty result. */
export const getRoomMediaTrack = (viewerId: string, mediaTrackId: string, signal?: AbortSignal) => {
  const id = roomMediaSchema.shape.mediaTrackId.parse(mediaTrackId);
  const schema = z.object({ item: roomMediaSchema.nullable() }).strict().refine(value => value.item === null || value.item.mediaTrackId === id);
  return socialReadRequest(`${base}/room-media/${id}`, schema, { ...options(viewerId), signal });
};
