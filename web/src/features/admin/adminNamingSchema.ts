import { z } from 'zod';

/**
 * Shared bounded naming/review values, independent of import media and publication DTOs, and the import project's Draft v2.
 * The v1 draft and suggestion that catalog reviews keep live in reviewNamingSchema.ts, outside the import route's bundle.
 */
export const uuidSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
const uuid = uuidSchema;
const integer = z.number().int().nonnegative();
export const importDateSchema = z.object({ year: z.number().int().min(1).max(9999), month: z.number().int().min(1).max(12).nullable(), day: z.number().int().min(1).max(31).nullable() }).strict().refine(value => {
  if (value.month === null) return value.day === null;
  if (value.day === null) return true;
  const leap = value.year % 4 === 0 && (value.year % 100 !== 0 || value.year % 400 === 0);
  return value.day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][value.month - 1];
}, 'Invalid calendar date');
const date = importDateSchema;
export const importValueSchema = z.union([z.string().max(2000), integer, date, z.null()]);
const value = importValueSchema;
export const analysisSchema = z.object({ state: z.enum(['idle', 'queued', 'running', 'complete', 'cancelled', 'needsAttention']), generation: integer, operationId: uuid.nullable(), completedChunks: integer, totalChunks: integer, attemptsUsed: integer, maxAttempts: integer, issue: z.enum(['providerUnavailable', 'providerRejected', 'providerInvalidResponse', 'providerOutcomeUnknown', 'permissionLost', 'grantExpired', 'budgetExhausted']).nullable() }).strict();
/** The suggestion fields both draft formats share; each format adds its own field names and value check. */
export const suggestionShape = { id: z.string().min(1).max(200), generation: integer, scope: z.enum(['album', 'track']), slotId: uuid.nullable(), source: z.enum(['filename', 'folder', 'context']), evidence: z.string().max(2000), decision: z.enum(['pending', 'accepted', 'rejected']) };
/** A scalar suggestion value valid for its field: a nullable calendar date, a nullable 1 to 9999 Track Number, or text. */
export const scalarSuggestionValue = (field: string, entry: unknown) => field === 'releaseDate' ? entry === null || date.safeParse(entry).success
  : field === 'trackNumber' ? entry === null || typeof entry === 'number' && entry >= 1 && entry <= 9999 : typeof entry === 'string';

// Draft v2 of an import project.
const musicBrainzId = z.string().regex(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
const name = z.string().min(1).max(200);
export const artistEntrySchema = z.object({ key: uuid, name, role: z.enum(['primary', 'featured']), joinPhrase: z.string().min(1).max(16).nullable(), musicBrainzId: musicBrainzId.nullable() }).strict();
export const labelEntrySchema = z.object({ name, musicBrainzId: musicBrainzId.nullable() }).strict();
const artistEntries = z.array(artistEntrySchema).max(20);
export const importDraftV2Schema = z.object({
  album: z.object({ title: z.string().max(300), artists: artistEntries, label: labelEntrySchema.nullable(), releaseDate: date.nullable(), visibility: z.enum(['public', 'hidden']) }).strict(),
  tracks: z.array(z.object({ slotId: uuid, title: z.string().max(300), discNumber: z.number().int().min(1).max(999).nullable(), trackNumber: z.number().int().min(1).max(9999).nullable() }).strict()).max(100)
}).strict();
const suggestionValue = z.union([value, artistEntries]);
export const importSuggestionV2Schema = z.object({ ...suggestionShape, field: z.enum(['title', 'artists', 'releaseDate', 'trackNumber']), baseline: suggestionValue, value: suggestionValue }).strict()
  .refine(suggestion => [suggestion.baseline, suggestion.value].every(entry => suggestion.field === 'artists' ? Array.isArray(entry) : !Array.isArray(entry) && scalarSuggestionValue(suggestion.field, entry)), 'Invalid field value');

export type ImportDraftV2 = z.infer<typeof importDraftV2Schema>;
export type ImportSuggestionV2 = z.infer<typeof importSuggestionV2Schema>;
export type ImportArtistEntry = z.infer<typeof artistEntrySchema>;
