import { z } from 'zod';
import { importDateSchema, analysisSchema } from './adminNamingSchema';
import { draftSchema, suggestionSchema } from './reviewNamingSchema';

const id = z.string().regex(/^[a-f0-9]{24}$/);
const uuid = z.string().uuid();
const integer = z.number().int().nonnegative();
const revision = z.string().regex(/^cr_[A-Za-z0-9_-]{43}$/);
const analysis = analysisSchema;
const receipt = z.object({ operationId: uuid, revision: integer, kind: z.enum(['create', 'edit', 'analyze', 'adopt', 'cancel-analysis', 'apply']) }).strict();
const field = z.object({ scope: z.enum(['album', 'track']), slotId: uuid.nullable(), field: z.enum(['title', 'releaseDate', 'trackNumber']) }).strict()
  .refine(value => value.scope === 'album' ? value.slotId === null && value.field !== 'trackNumber' : value.slotId !== null && value.field !== 'releaseDate');
const source = z.object({
  album: z.object({ id, revision, title: z.string().max(300), releaseDate: importDateSchema.nullable(), visibility: z.enum(['public', 'hidden']) }).strict(),
  tracks: z.array(z.object({ slotId: uuid, id, revision, title: z.string().max(300), trackNumber: z.number().int().min(1).max(9999).nullable(),
    originalFileName: z.string().min(1).max(255).refine(value => value.trim() === value && !/[\\/:\u0000-\u001f\u007f-\u009f]/u.test(value)
      && !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(value) && value !== '.' && value !== '..').nullable() }).strict()).max(100)
}).strict();
export const reviewDetailSchema = z.object({ id, revision: integer, createdAt: z.string(), updatedAt: z.string(), startedByMe: z.boolean(),
  state: z.enum(['reviewing', 'applied']), source, sourceStatus: z.enum(['current', 'changed', 'unavailable']), draft: draftSchema,
  analysis, suggestions: z.array(suggestionSchema).max(1000), capabilities: z.object({ analysis: z.boolean(), apply: z.boolean() }).strict(),
  applied: z.object({ operationId: uuid, at: z.string(), fields: z.array(field).max(202) }).strict().nullable(), receipts: z.array(receipt).max(256)
}).strict().superRefine((item, ctx) => {
  const slots = new Set(item.source.tracks.map(track => track.slotId));
  if (slots.size !== item.source.tracks.length || new Set(item.source.tracks.map(track => track.id)).size !== slots.size
    || item.draft.tracks.length !== slots.size || new Set(item.draft.tracks.map(track => track.slotId)).size !== slots.size
    || item.draft.tracks.some(track => !slots.has(track.slotId)) || item.draft.album.visibility !== item.source.album.visibility
    || (item.state === 'applied') !== (item.applied !== null)) ctx.addIssue({ code: 'custom', message: 'Invalid catalog review source' });
  for (const suggestion of item.suggestions) {
    if (suggestion.generation !== item.analysis.generation || (suggestion.scope === 'album'
      ? suggestion.slotId !== null || suggestion.field === 'trackNumber'
      : !slots.has(suggestion.slotId ?? '') || !['title', 'trackNumber'].includes(suggestion.field))) ctx.addIssue({ code: 'custom', message: 'Invalid catalog review suggestion' });
    const filename = suggestion.scope === 'track' ? item.source.tracks.find(track => track.slotId === suggestion.slotId)?.originalFileName
      : item.source.tracks.some(track => track.originalFileName !== null);
    if (suggestion.source === 'folder' || suggestion.source === 'filename' && !filename
      || suggestion.field === 'trackNumber' && (suggestion.source !== 'filename' || !filename)) ctx.addIssue({ code: 'custom', message: 'Missing catalog naming evidence' });
  }
  const paths = new Set<string>();
  for (const value of item.applied?.fields ?? []) {
    const path = reviewFieldKey(value);
    if (paths.has(path) || value.scope === 'track' && !slots.has(value.slotId!)) ctx.addIssue({ code: 'custom', message: 'Invalid applied review field' });
    paths.add(path);
  }
});
export const reviewResponseSchema = z.object({ item: reviewDetailSchema, receipt: receipt.nullable() }).strict();
export const reviewMutationSchema = z.object({ item: reviewDetailSchema, receipt }).strict();
export const reviewWorkbenchSchema = z.object({
  items: z.array(z.object({ id, revision: integer, createdAt: z.string(), updatedAt: z.string(), startedByMe: z.boolean(), state: z.enum(['reviewing', 'applied']), analysis, albumId: id, title: z.string().max(300), pendingSuggestions: integer }).strict()).max(25),
  counts: z.object({ all: integer, analyzing: integer, awaitingReview: integer, needsAttention: integer, completed: integer }).strict(), nextCursor: z.string().max(500).nullable()
}).strict();
export type CatalogReview = z.infer<typeof reviewDetailSchema>;
export type ReviewField = z.infer<typeof field>;
export type ReviewMutation = z.infer<typeof reviewMutationSchema>;
export type ReviewChange = ReviewField & { baseline: unknown; value: unknown; title: string };
export const reviewFieldKey = (value: ReviewField) => `${value.scope}:${value.slotId ?? ''}:${value.field}`;

/** Only explicit metadata differences are eligible; names cannot imply an Artist identity change. */
export function reviewChanges(item: CatalogReview): ReviewChange[] {
  const values: ReviewChange[] = [];
  for (const field of ['title', 'releaseDate'] as const) {
    const baseline = item.source.album[field], value = item.draft.album[field];
    if (JSON.stringify(baseline) !== JSON.stringify(value)) values.push({ scope: 'album', slotId: null, field, baseline, value, title: item.source.album.title });
  }
  for (const track of item.source.tracks) {
    const draft = item.draft.tracks.find(value => value.slotId === track.slotId)!;
    for (const field of ['title', 'trackNumber'] as const) {
      if (track[field] !== draft[field]) values.push({ scope: 'track', slotId: track.slotId, field, baseline: track[field], value: draft[field], title: track.title });
    }
  }
  return values;
}
