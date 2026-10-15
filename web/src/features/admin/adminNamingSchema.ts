import { z } from 'zod';

/** Shared bounded naming/review values, independent of import media and publication DTOs. */
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
const integer = z.number().int().nonnegative();
export const importDateSchema = z.object({ year: z.number().int().min(1).max(9999), month: z.number().int().min(1).max(12).nullable(), day: z.number().int().min(1).max(31).nullable() }).strict().refine(value => {
  if (value.month === null) return value.day === null;
  if (value.day === null) return true;
  const leap = value.year % 4 === 0 && (value.year % 100 !== 0 || value.year % 400 === 0);
  return value.day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][value.month - 1];
}, 'Invalid calendar date');
const date = importDateSchema;
const value = z.union([z.string().max(2000), integer, date, z.null()]);
export const draftSchema = z.object({
  album: z.object({ title: z.string().max(300), artistName: z.string().max(200), releaseDate: date.nullable(), visibility: z.enum(['public', 'hidden']) }).strict(),
  tracks: z.array(z.object({ slotId: uuid, title: z.string().max(300), trackNumber: z.number().int().min(1).max(9999).nullable() }).strict()).max(100)
}).strict();
export const analysisSchema = z.object({ state: z.enum(['idle', 'queued', 'running', 'complete', 'cancelled', 'needsAttention']), generation: integer, operationId: uuid.nullable(), completedChunks: integer, totalChunks: integer, attemptsUsed: integer, maxAttempts: integer, issue: z.enum(['providerUnavailable', 'providerRejected', 'providerInvalidResponse', 'providerOutcomeUnknown', 'permissionLost', 'grantExpired', 'budgetExhausted']).nullable() }).strict();
export const suggestionSchema = z.object({ id: z.string().min(1).max(200), generation: integer, scope: z.enum(['album', 'track']), slotId: uuid.nullable(), field: z.enum(['title', 'artistName', 'releaseDate', 'trackNumber']), baseline: value, value, source: z.enum(['filename', 'folder', 'context']), evidence: z.string().max(2000), decision: z.enum(['pending', 'accepted', 'rejected']) }).strict().refine(suggestion => [suggestion.baseline, suggestion.value].every(entry => suggestion.field === 'releaseDate' ? entry === null || date.safeParse(entry).success : suggestion.field === 'trackNumber' ? entry === null || typeof entry === 'number' && entry >= 1 && entry <= 9999 : typeof entry === 'string'), 'Invalid field value');

export type ImportDraft = z.infer<typeof draftSchema>;
export type ImportSuggestion = z.infer<typeof suggestionSchema>;
