import { z } from 'zod';
import { importDraftV2Schema, importSuggestionV2Schema, analysisSchema } from './adminNamingSchema';
export { importDateSchema, analysisSchema, artistEntrySchema, labelEntrySchema, importDraftV2Schema, importSuggestionV2Schema } from './adminNamingSchema';
export type { ImportDraftV2, ImportSuggestionV2, ImportArtistEntry, ImportLabelEntry } from './adminNamingSchema';
// Catalog reviews keep the v1 draft; its runtime schemas are imported from reviewNamingSchema.ts directly.
export type { ImportDraft, ImportSuggestion } from './reviewNamingSchema';
export { ADMIN_IMPORT_APPEND_VISIBILITY_MISMATCH, ADMIN_IMPORT_RELOAD_REQUIRED, adminEndpointRequest, adminRequest, importPath } from './adminTransport';
export type { AdminGuard } from './adminTransport';

const id = z.string().regex(/^[a-f0-9]{24}$/);
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
const integer = z.number().int().nonnegative();
export const manifestSchema = z.object({ rootLabel: z.string().max(200), files: z.array(z.object({ slotId: uuid, filename: z.string().max(255), relativePath: z.string().max(1024), byteLength: integer.nullable() }).strict()).min(1).max(100) }).strict();
const receiptSchema = z.object({ operationId: uuid, kind: z.enum(['create', 'edit', 'analyze', 'adopt', 'decisions', 'cancel-analysis', 'cancel-publication', 'upload', 'publish', 'cleanup', 'select-cover']), revision: integer }).strict();
export const decisionSchema = z.object({ scope: z.enum(['artist', 'album', 'track']), slotId: uuid.nullable(), action: z.enum(['reuse', 'skip', 'create-distinct']), candidateId: id.nullable(), candidateRevision: z.string().nullable() }).strict();
const upload = z.object({ ready: integer, total: integer, available: z.boolean() }).strict();
export const assetRecoverySchema = z.object({ operationId: uuid, expectedRevision: integer, kind: z.enum(['upload', 'cleanup']), startedByMe: z.boolean() }).strict();
const common = { id, revision: integer, createdAt: z.string(), updatedAt: z.string(), startedByMe: z.boolean(), analysis: analysisSchema, upload, publication: z.enum(['notAvailable', 'notStarted', 'preparing', 'needsAttention', 'cancelled', 'complete']) };
// An import project carries Draft v2: ordered Artist entries, an optional label and per-track Disc Numbers.
export const detailSchema = z.object({ ...common, manifest: manifestSchema, draft: importDraftV2Schema,
  publicationRecovery: z.object({ operationId: uuid, cleanupPending: z.boolean(), startedByMe: z.boolean() }).strict().nullable().default(null),
  suggestions: z.array(importSuggestionV2Schema).max(1000), decisions: z.array(decisionSchema).max(102),
  assets: z.array(z.object({ slotId: z.string(), state: z.enum(['pending', 'ready', 'failed', 'unknown', 'deleting', 'cleanupFailed', 'deleted']), byteLength: integer, sha256: z.string().regex(/^[a-f0-9]{64}$/), contentType: z.string(), recovery: assetRecoverySchema.nullable().default(null), tags: z.object({ title: z.string().nullable(), album: z.string().nullable(), artists: z.array(z.string()).max(50), year: integer.nullable(), trackNumber: integer.nullable() }).strict().nullable().default(null) }).strict()).max(201).default([]),
  selectedCoverSlotId: z.string().nullable().default(null),
  published: z.object({ albumId: id, artistId: id, trackIds: z.array(id).max(100) }).strict().nullable().default(null),
  capabilities: z.object({ analysis: z.boolean(), upload: z.boolean(), publish: z.boolean() }).strict(), receipts: z.array(receiptSchema).max(256)
}).strict().superRefine((item, ctx) => {
  if (item.publication === 'cancelled' && item.publicationRecovery === null || item.publicationRecovery?.cleanupPending && item.publication !== 'cancelled') ctx.addIssue({ code: 'custom', message: 'Invalid publication recovery' });
  const slots = new Set(item.manifest.files.map(file => file.slotId));
  if (slots.size !== item.manifest.files.length || item.draft.tracks.length !== slots.size || new Set(item.draft.tracks.map(track => track.slotId)).size !== slots.size || item.draft.tracks.some(track => !slots.has(track.slotId))) ctx.addIssue({ code: 'custom', message: 'Invalid file mapping' });
  for (const suggestion of item.suggestions) {
    if (suggestion.generation !== item.analysis.generation || (suggestion.scope === 'album' ? suggestion.slotId !== null || suggestion.field === 'trackNumber' : !slots.has(suggestion.slotId ?? '') || !['title', 'trackNumber'].includes(suggestion.field))) ctx.addIssue({ code: 'custom', message: 'Invalid suggestion path' });
  }
  const assets = new Set(item.assets.map(asset => asset.slotId));
  if (assets.size !== item.assets.length || item.assets.some(asset => asset.slotId !== 'cover' && !slots.has(asset.slotId) && !(asset.slotId.startsWith('embedded-') && slots.has(asset.slotId.slice(9)))) || item.selectedCoverSlotId !== null && !item.assets.some(asset => asset.slotId === item.selectedCoverSlotId && asset.state === 'ready' && asset.contentType.startsWith('image/'))) ctx.addIssue({ code: 'custom', message: 'Invalid asset mapping' });
});
export const responseSchema = z.object({ item: detailSchema, receipt: receiptSchema.nullable() }).strict();
export const filters = ['all', 'analyzing', 'awaitingReview', 'needsAttention', 'completed'] as const;
export const workbenchSchema = z.object({ items: z.array(z.object({ ...common, title: z.string(), rootLabel: z.string(), artistName: z.string(), visibility: z.enum(['public', 'hidden']), pendingSuggestions: integer }).strict()).max(25), counts: z.object({ all: integer, analyzing: integer, awaitingReview: integer, needsAttention: integer, completed: integer }).strict(), nextCursor: z.string().nullable() }).strict();
export const candidatesSchema = z.object({ items: z.array(z.object({ kind: z.enum(['artist', 'album', 'track']), id, label: z.string(), revision: z.string(), albumId: id.nullable(), visibility: z.enum(['public', 'hidden']), match: z.enum(['name', 'sha256']), matchedSlotIds: z.array(uuid).max(100), automaticReuse: z.literal(false) }).strict()).max(60) }).strict();
export type ImportDetail = z.infer<typeof detailSchema>;
export type ImportDecision = z.infer<typeof decisionSchema>;
export type ImportResponse = z.infer<typeof responseSchema>;
export type WorkbenchItem = z.infer<typeof workbenchSchema>['items'][number];
export type WorkbenchFilter = typeof filters[number];
