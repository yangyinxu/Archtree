import { z } from 'zod';
import { parseListeningReport, type OwnListeningState, type FriendListeningStatus, type ListeningReport, type ListeningReportResult } from '../../../src/contracts/listeningV1';
import { apiRequest } from './client';
import { socialReadRequest } from './socialReadRequest';
import { socialCardSchema, socialRevisionSchema } from './socialSchemas';

const artwork = z.string().max(2048).refine(value => {
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return false;
  if (!value || value.startsWith('/') && !value.startsWith('//')) return true;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; }
});
const text = (length: number) => z.string().refine(value => [...value].length <= length);
export const ownListeningSchema = z.object({ enabled: z.boolean(), revision: socialRevisionSchema,
  publisherRevision: socialRevisionSchema, serverTimeMs: socialRevisionSchema }).strict() satisfies z.ZodType<OwnListeningState>;
export const listeningStatusSchema = z.object({ peer: socialCardSchema,
  track: z.object({ contentType: z.literal('audioTrack'), id: z.string().regex(/^[a-f0-9]{24}$/), title: text(200),
    artworkUrl: artwork, artistNames: z.array(text(160)).max(20) }).strict(), expiresAtMs: socialRevisionSchema
}).strict() satisfies z.ZodType<FriendListeningStatus>;
export const listeningReportResultSchema = z.object({ accepted: z.boolean(), serverTimeMs: socialRevisionSchema,
  expiresAtMs: socialRevisionSchema.nullable() }).strict() satisfies z.ZodType<ListeningReportResult>;

/** Retains a monotonic receive boundary so wall-clock changes cannot age or refresh an observation. */
export const getOwnListening = async (viewerId: string, signal?: AbortSignal) => {
  const result = await socialReadRequest('/api/social/v1/me/listening', z.object({ listening: ownListeningSchema }).strict(), { accountViewer: viewerId, signal });
  return { ...result, receivedAtMs: performance.now() };
};
export type ListeningOwnerRead = Awaited<ReturnType<typeof getOwnListening>>;

/**
 * Pages every currently listening friend in opaque social-ID order. The server decides who is a current friend,
 * so listening beyond the first page of the friend list is visible and the client never sends friend IDs.
 */
export const getListeningFriends = (viewerId: string, cursor?: string, signal?: AbortSignal) => {
  const query = new URLSearchParams({ limit: '20' });
  if (cursor) query.set('cursor', cursor);
  const schema = z.object({ items: z.array(listeningStatusSchema).max(50),
    nextCursor: z.string().min(1).max(1024).regex(/^[A-Za-z0-9_.-]+$/).nullable() }).strict()
    .refine(result => new Set(result.items.map(item => item.peer.socialId)).size === result.items.length);
  return socialReadRequest(`/api/social/v1/listening-status/friends?${query}`, schema, { accountViewer: viewerId, signal });
};
export type ListeningFriendsPage = Awaited<ReturnType<typeof getListeningFriends>>;

/** Sends one immutable observation or captured stop; publication reports are never automatically retried here. */
export const sendListeningReport = (viewerId: string, report: ListeningReport) => {
  const parsed = parseListeningReport(report); if (!parsed) throw new Error('Invalid listening report.');
  return apiRequest('/api/social/v1/listening-publications/report', listeningReportResultSchema, {
    accountViewer: viewerId, method: 'POST', body: JSON.stringify(parsed)
  });
};
export type { OwnListeningState, FriendListeningStatus, ListeningReport, ListeningReportResult };
