import { z } from 'zod';
import { importDateSchema, importValueSchema, scalarSuggestionValue, suggestionShape, uuidSchema } from './adminNamingSchema';

/**
 * The v1 naming draft and suggestion that catalog reviews keep. Import projects use Draft v2 (adminNamingSchema.ts); keeping
 * these apart keeps them out of the import route's initial bundle.
 */
export const draftSchema = z.object({
  album: z.object({ title: z.string().max(300), artistName: z.string().max(200), releaseDate: importDateSchema.nullable(), visibility: z.enum(['public', 'hidden']) }).strict(),
  tracks: z.array(z.object({ slotId: uuidSchema, title: z.string().max(300), trackNumber: z.number().int().min(1).max(9999).nullable() }).strict()).max(100)
}).strict();
export const suggestionSchema = z.object({ ...suggestionShape, field: z.enum(['title', 'artistName', 'releaseDate', 'trackNumber']), baseline: importValueSchema, value: importValueSchema }).strict()
  .refine(suggestion => [suggestion.baseline, suggestion.value].every(entry => scalarSuggestionValue(suggestion.field, entry)), 'Invalid field value');

export type ImportDraft = z.infer<typeof draftSchema>;
export type ImportSuggestion = z.infer<typeof suggestionSchema>;
