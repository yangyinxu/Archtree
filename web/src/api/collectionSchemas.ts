import { z } from 'zod';

import {
  albumSummarySchema,
  audioTrackSummarySchema,
  type AlbumSummary,
  type AudioTrackSummary
} from './contentSchemas';

export const maximumListenerCollectionCursorLength = 2_048;

const contentIdSchema = z.string().trim().min(1);
const listenerPageSlugSchema = z.enum(['home', 'library']);
const collectionPageContentTypeSchema = z.enum(['album', 'audioTrack']);
const collectionPageItemSchema = z
  .object({
    contentType: collectionPageContentTypeSchema,
    contentId: contentIdSchema,
    order: z.number().int().min(0)
  })
  .strip();

/** Validates known fields and reference integrity while discarding additive response fields. */
export const listenerCollectionPageSchema = z
  .object({
    pageItem: z
      .object({
        id: contentIdSchema,
        pageSlug: listenerPageSlugSchema,
        title: z.string(),
        presentation: z.enum(['grid', 'list']),
        mode: z.literal('manual'),
        contentType: collectionPageContentTypeSchema
      })
      .strip(),
    items: z.array(collectionPageItemSchema).max(100),
    included: z
      .object({
        albums: z.array(albumSummarySchema).max(100),
        audioTracks: z.array(audioTrackSummarySchema).max(100)
      })
      .strip(),
    limit: z.number().int().min(1).max(100),
    nextCursor: z.string().trim().min(1).max(maximumListenerCollectionCursorLength).nullable()
  })
  .strip()
  .superRefine((page, context) => {
    if (page.pageItem.presentation === 'grid' && page.pageItem.contentType !== 'album') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Grid page items must contain Albums.',
        path: ['pageItem', 'contentType']
      });
    }

    const includedCounts = new Map<string, number>();
    for (const item of [...page.included.albums, ...page.included.audioTracks]) {
      const key = `${item.contentType}:${item.id}`;
      includedCounts.set(key, (includedCounts.get(key) ?? 0) + 1);
    }

    let previousOrder = -1;
    page.items.forEach((item, index) => {
      if (item.contentType !== page.pageItem.contentType) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Collection references must match the declared content type.',
          path: ['items', index, 'contentType']
        });
      }
      if (item.order <= previousOrder) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Collection references must preserve increasing configured order.',
          path: ['items', index, 'order']
        });
      }
      previousOrder = item.order;

      const key = `${item.contentType}:${item.contentId}`;
      const count = includedCounts.get(key) ?? 0;
      if (count === 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Every collection reference must have one included summary.',
          path: ['items', index, 'contentId']
        });
      } else {
        includedCounts.set(key, count - 1);
      }
    });

    for (const count of includedCounts.values()) {
      if (count !== 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Included summaries must match the ordered references exactly.',
          path: ['included']
        });
        break;
      }
    }
  });

export type ListenerPageSlug = z.infer<typeof listenerPageSlugSchema>;
export type ListenerCollectionPage = z.infer<typeof listenerCollectionPageSchema>;

/** Rejoins allowlisted summaries to the exact configured reference order. */
export const collectionPageSummaries = (
  page: ListenerCollectionPage
): Array<AlbumSummary | AudioTrackSummary> => {
  const summaries = new Map<string, Array<AlbumSummary | AudioTrackSummary>>();
  for (const item of [...page.included.albums, ...page.included.audioTracks]) {
    const key = `${item.contentType}:${item.id}`;
    summaries.set(key, [...(summaries.get(key) ?? []), item]);
  }
  return page.items.map((item) => {
    const key = `${item.contentType}:${item.contentId}`;
    return summaries.get(key)!.shift()!;
  });
};
