import { z } from 'zod';
import { importDateSchema } from './adminApi';
export const catalogKinds = ['album', 'artist', 'audioTrack', 'organization'] as const;
export type CatalogKind = typeof catalogKinds[number];
const id = z.string().regex(/^[a-f0-9]{24}$/);
export const revision = z.string().regex(/^cr_[A-Za-z0-9_-]{43}$/);
export const creditRoles = ['primary', 'featured', 'performer', 'composer', 'producer', 'remixer', 'label', 'publisher', 'distributor', 'presenter', 'legacyUnspecified'] as const;
const credit = z.object({ creditId: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/), subjectType: z.enum(['artist', 'organization']), subjectId: id, role: z.enum(creditRoles), order: z.number().int().nonnegative() }).strict();
const sharedFields = { title: z.string(), releaseDate: importDateSchema.nullable(), credits: z.array(credit).max(50).nullable(), attributionStatus: z.enum(['documented', 'unknown']) };
const common = { id, revision, visibility: z.enum(['public', 'hidden']), effectiveVisibility: z.enum(['public', 'hidden']), coverUrl: z.string().nullable(), mediaUrl: z.string().nullable(), capabilities: z.object({ editing: z.boolean(), visibility: z.boolean() }).strict() };
export const catalogItemSchema = z.discriminatedUnion('kind', [
  z.object({ ...common, kind: z.literal('album'), fields: z.object(sharedFields).strict() }).strict(),
  z.object({ ...common, kind: z.literal('audioTrack'), fields: z.object({ ...sharedFields, trackNumber: z.number().int().positive().nullable() }).strict() }).strict(),
  z.object({ ...common, kind: z.literal('artist'), fields: z.object({ name: z.string(), bio: z.string(), birthDate: importDateSchema.nullable() }).strict() }).strict(),
  z.object({ ...common, kind: z.literal('organization'), fields: z.object({ name: z.string(), description: z.string(), organizationType: z.enum(['label', 'publisher', 'distributor', 'archive', 'broadcaster', 'studio', 'other']) }).strict() }).strict()
]).refine(item => (item.coverUrl === null || item.coverUrl === `/api/admin/v1/catalog/${item.kind}/${item.id}/artwork`)
  && (item.mediaUrl === null || item.kind === 'audioTrack' && item.mediaUrl === `/api/admin/v1/catalog/audioTrack/${item.id}/media`), 'Invalid private source');
export const catalogResponse = z.object({ item: catalogItemSchema }).strict();
export const catalogMutationResponse = z.object({ item: catalogItemSchema, receipt: z.object({ operationId: z.string() }).strict() }).strict();
export const catalogList = z.object({ items: z.array(catalogItemSchema).max(25), nextCursor: id.nullable() }).strict();
const pageSchema = z.object({ slug: z.enum(['home', 'library']), title: z.string(), revision, items: z.array(z.object({ itemId: id, itemType: z.enum(['carousel', 'grid', 'list']), visibility: z.enum(['public', 'hidden']), order: z.number(), referenceId: z.string(), name: z.string().max(300).nullable().default(null), sourceMode: z.enum(['manual', 'dynamic']).nullable().default(null), referenceStatus: z.enum(['ready', 'missing', 'unsupported']).nullable().default(null) }).strict()).max(1000) }).strict();
export const pageResponse = z.object({ page: pageSchema }).strict();
export const pageMutationResponse = z.object({ page: pageSchema, receipt: z.object({ operationId: z.string() }).strict() }).strict();
export type CatalogItem = z.infer<typeof catalogItemSchema>;
export type CatalogCredit = z.infer<typeof credit>;
export type AdminPage = z.infer<typeof pageSchema>;
/** Sends only fields the administrator actually edited; unrelated legacy values cannot be overwritten. */
export function catalogPatch(item: CatalogItem, fields: CatalogItem['fields'], visibility: 'public' | 'hidden') {
  const previous = item.fields as Record<string, unknown>;
  const changed = Object.fromEntries(Object.entries(fields).filter(([key, value]) => JSON.stringify(previous[key]) !== JSON.stringify(value)));
  if ('credits' in changed || 'attributionStatus' in changed) {
    if ('credits' in fields) { changed.credits = fields.credits; changed.attributionStatus = fields.attributionStatus; }
  }
  return { expectedRevision: item.revision, ...(Object.keys(changed).length ? { fields: changed } : {}), ...(visibility !== item.visibility ? { visibility } : {}) };
}
