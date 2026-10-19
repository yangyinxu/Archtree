import { z } from 'zod';
import { importDateSchema, analysisSchema, importDraftV2Schema, importSuggestionV2Schema } from './adminNamingSchema';

const id = z.string().regex(/^[a-f0-9]{24}$/);
const uuid = z.string().uuid();
const integer = z.number().int().nonnegative();
const revision = z.string().regex(/^cr_[A-Za-z0-9_-]{43}$/);
const analysis = analysisSchema;
const receipt = z.object({ operationId: uuid, revision: integer, kind: z.enum(['create', 'edit', 'analyze', 'adopt', 'cancel-analysis', 'apply']) }).strict();
const field = z.object({ scope: z.enum(['album', 'track']), slotId: uuid.nullable(), field: z.enum(['title', 'releaseDate', 'discNumber', 'trackNumber']) }).strict()
  .refine(value => value.scope === 'album' ? value.slotId === null && (value.field === 'title' || value.field === 'releaseDate') : value.slotId !== null && value.field !== 'releaseDate');
const source = z.object({
  album: z.object({ id, revision, title: z.string().max(300), releaseDate: importDateSchema.nullable(), visibility: z.enum(['public', 'hidden']) }).strict(),
  // An absent discNumber was not captured (a review created before Disc Numbers were); null means the Track stored none.
  tracks: z.array(z.object({ slotId: uuid, id, revision, title: z.string().max(300), discNumber: z.number().int().min(1).max(999).nullable().optional(), trackNumber: z.number().int().min(1).max(9999).nullable(),
    originalFileName: z.string().min(1).max(255).refine(value => value.trim() === value && !/[\\/:\u0000-\u001f\u007f-\u009f]/u.test(value)
      && !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(value) && value !== '.' && value !== '..').nullable() }).strict()).max(100)
}).strict();
export const reviewDetailSchema = z.object({ id, revision: integer, createdAt: z.string(), updatedAt: z.string(), startedByMe: z.boolean(),
  state: z.enum(['reviewing', 'applied']), source, sourceStatus: z.enum(['current', 'changed', 'unavailable']), draft: importDraftV2Schema,
  analysis, suggestions: z.array(importSuggestionV2Schema).max(1000), capabilities: z.object({ analysis: z.boolean(), apply: z.boolean() }).strict(),
  applied: z.object({ operationId: uuid, at: z.string(), fields: z.array(field).max(302) }).strict().nullable(), receipts: z.array(receipt).max(256)
}).strict().superRefine((item, ctx) => {
  const slots = new Set(item.source.tracks.map(track => track.slotId));
  if (slots.size !== item.source.tracks.length || new Set(item.source.tracks.map(track => track.id)).size !== slots.size
    || item.draft.tracks.length !== slots.size || new Set(item.draft.tracks.map(track => track.slotId)).size !== slots.size
    || item.draft.tracks.some(track => !slots.has(track.slotId)) || item.draft.album.visibility !== item.source.album.visibility
    || (item.state === 'applied') !== (item.applied !== null)) ctx.addIssue({ code: 'custom', message: 'Invalid catalog review source' });
  for (const suggestion of item.suggestions) {
    // Each field's scope is checked by the suggestion schema; here the slot and generation.
    if (suggestion.generation !== item.analysis.generation || (suggestion.scope === 'album' ? suggestion.slotId !== null : !slots.has(suggestion.slotId ?? ''))) ctx.addIssue({ code: 'custom', message: 'Invalid catalog review suggestion' });
    const filename = suggestion.scope === 'track' ? item.source.tracks.find(track => track.slotId === suggestion.slotId)?.originalFileName
      : item.source.tracks.some(track => track.originalFileName !== null);
    if (suggestion.source === 'folder' || suggestion.source === 'filename' && !filename
      || (suggestion.field === 'trackNumber' || suggestion.field === 'discNumber') && (suggestion.source !== 'filename' || !filename)) ctx.addIssue({ code: 'custom', message: 'Missing catalog naming evidence' });
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

/**
 * Only explicit metadata differences are eligible: Album title and date, then per Track its title, Disc Number (only where the
 * source captured one) and Track Number. Artist entries, label and visibility are read-only context and never become changes.
 */
export function reviewChanges(item: CatalogReview): ReviewChange[] {
  const values: ReviewChange[] = [];
  for (const field of ['title', 'releaseDate'] as const) {
    const baseline = item.source.album[field], value = item.draft.album[field];
    if (JSON.stringify(baseline) !== JSON.stringify(value)) values.push({ scope: 'album', slotId: null, field, baseline, value, title: item.source.album.title });
  }
  for (const track of item.source.tracks) {
    const draft = item.draft.tracks.find(value => value.slotId === track.slotId)!;
    for (const field of ['title', 'discNumber', 'trackNumber'] as const) {
      if (field === 'discNumber' && track.discNumber === undefined) continue;
      if (track[field] !== draft[field]) values.push({ scope: 'track', slotId: track.slotId, field, baseline: track[field], value: draft[field], title: track.title });
    }
  }
  return values;
}
