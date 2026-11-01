import { z } from 'zod';
import { revision } from './catalogRevision';

const id = z.string().regex(/^[a-f0-9]{24}$/);
/** Page reads and both mutation kinds use the same allowlisted snapshot. */
const pageSchema = z.object({ slug: z.enum(['home', 'library']), title: z.string(), revision, items: z.array(z.object({ itemId: id, itemType: z.enum(['carousel', 'grid', 'list']), visibility: z.enum(['public', 'hidden']), order: z.number(), referenceId: z.string(), name: z.string().max(300).nullable().default(null), sourceMode: z.enum(['manual', 'dynamic']).nullable().default(null), referenceStatus: z.enum(['ready', 'missing', 'unsupported']).nullable().default(null) }).strict()).max(1000) }).strict();
export const pageResponse = z.object({ page: pageSchema }).strict();
export const pageMutationResponse = z.object({ page: pageSchema, receipt: z.object({ operationId: z.string() }).strict() }).strict();
export type AdminPage = z.infer<typeof pageSchema>;
