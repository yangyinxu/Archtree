import { z } from 'zod';
import { parseListeningReport, type OwnListeningState, type FriendListeningStatus, type ListeningReport, type ListeningReportResult } from '../../../src/contracts/listeningV1';
import { apiRequest } from './client';
import { socialReadRequest } from './socialReadRequest';
import { socialCardSchema, socialIdSchema, socialRevisionSchema } from './socialSchemas';

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

/** Requests only the exact bounded set of already-observed friends, never an account-wide public feed. */
export const getListeningStatuses = (viewerId: string, socialIds: string[], signal?: AbortSignal) => {
  const ids = z.array(socialIdSchema).min(1).max(50).refine(values => new Set(values).size === values.length).parse(socialIds);
  const schema = z.object({ items: z.array(listeningStatusSchema).max(50) }).strict().refine(result =>
    new Set(result.items.map(item => item.peer.socialId)).size === result.items.length && result.items.every(item => ids.includes(item.peer.socialId)));
  return socialReadRequest('/api/social/v1/listening-status/query', schema, { accountViewer: viewerId, signal,
    method: 'POST', body: JSON.stringify({ socialIds: ids }) });
};

/** Sends one immutable observation or captured stop; publication reports are never automatically retried here. */
export const sendListeningReport = (viewerId: string, report: ListeningReport) => {
  const parsed = parseListeningReport(report); if (!parsed) throw new Error('Invalid listening report.');
  return apiRequest('/api/social/v1/listening-publications/report', listeningReportResultSchema, {
    accountViewer: viewerId, method: 'POST', body: JSON.stringify(parsed)
  });
};
export type { OwnListeningState, FriendListeningStatus, ListeningReport, ListeningReportResult };
