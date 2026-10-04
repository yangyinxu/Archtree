import { z } from 'zod';
import type { MusicSharePage, MusicShareDirection } from '../../../src/contracts/socialMusicV1';
import { socialCardSchema, socialRevisionSchema } from './socialSchemas';
import { socialReadRequest } from './socialReadRequest';

const contentId = z.string().regex(/^[a-f0-9]{24}$/);
const contentType = z.enum(['audioTrack', 'album']);
const text = (length: number) => z.string().refine(value => [...value].length <= length);
const content = z.object({ id: contentId, contentType, title: text(200),
  artworkUrl: z.string().max(4096), artistNames: z.array(text(160)).max(20) }).strict();

/** Private cards contain only current public music and social projections, never playback URLs. */
export const musicSharePageSchema = z.object({ items: z.array(z.object({
  shareId: z.string().regex(/^ms_[a-f0-9]{32}$/), peer: socialCardSchema,
  contentId, contentType, content: content.nullable(),
  createdAtMs: socialRevisionSchema, expiresAtMs: socialRevisionSchema
}).strict().refine(item => item.expiresAtMs > item.createdAtMs && (!item.content
  || item.content.id === item.contentId && item.content.contentType === item.contentType), 'Share identity must match current music.')).max(50),
  nextCursor: z.string().min(1).max(1024).nullable()
}).strict().refine(page => new Set(page.items.map(item => item.shareId)).size === page.items.length,
  'Share identities must be unique.') satisfies z.ZodType<MusicSharePage>;

/** Serializes account-owned reads and rejects mismatched account responses before caching. */
export const getMusicShares = (viewerId: string, direction: MusicShareDirection, cursor?: string, signal?: AbortSignal) => {
  const query = new URLSearchParams({ direction: z.enum(['incoming', 'outgoing']).parse(direction), limit: '20' });
  if (cursor) query.set('cursor', z.string().min(1).max(1024).parse(cursor));
  return socialReadRequest(`/api/social/v1/music-shares?${query}`, musicSharePageSchema, { accountViewer: viewerId, signal });
};

export type { MusicShareItem, MusicSharePage, MusicShareDirection, SharedMusicType } from '../../../src/contracts/socialMusicV1';
