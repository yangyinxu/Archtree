import { z } from 'zod';
import { importDraftV2Schema, importSuggestionV2Schema, analysisSchema } from './adminNamingSchema';
export { importDateSchema, analysisSchema, artistEntrySchema, labelEntrySchema, importDraftV2Schema, importSuggestionV2Schema } from './adminNamingSchema';
export type { ImportDraftV2, ImportSuggestionV2, ImportArtistEntry, ImportLabelEntry } from './adminNamingSchema';
// Catalog reviews keep the v1 draft; its runtime schemas are imported from reviewNamingSchema.ts directly.
export type { ImportDraft, ImportSuggestion } from './reviewNamingSchema';
export { ADMIN_IMPORT_RELOAD_REQUIRED, adminEndpointRequest, adminRequest, importPath } from './adminTransport';
export type { AdminGuard } from './adminTransport';

const id = z.string().regex(/^[a-f0-9]{24}$/);
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
const integer = z.number().int().nonnegative();
/** Draft value paths in draft order: 5 album values and 3 per file. */
const draftPaths = z.array(z.string().max(80)).max(305).default([]);
export const manifestSchema = z.object({ rootLabel: z.string().max(200), files: z.array(z.object({ slotId: uuid, filename: z.string().max(255), relativePath: z.string().max(1024), byteLength: integer.nullable() }).strict()).min(1).max(100) }).strict();
const receiptSchema = z.object({ operationId: uuid, kind: z.enum(['create', 'edit', 'analyze', 'adopt', 'decisions', 'cancel-analysis', 'cancel-publication', 'upload', 'publish', 'cleanup', 'select-cover',
  'lookup', 'lookup-retry', 'lookup-choose', 'lookup-resolve']), revision: integer }).strict();
/** One identity decision: an Artist decision names its entry (entryKey) and both it and a label decision the name they were made for (boundName). */
export const decisionSchema = z.object({ scope: z.enum(['artist', 'label', 'album', 'track']), slotId: uuid.nullable(), entryKey: uuid.nullable(), boundName: z.string().max(200).nullable(), action: z.enum(['reuse', 'skip', 'create-distinct']), candidateId: id.nullable(), candidateRevision: z.string().nullable() }).strict();
const upload = z.object({ ready: integer, total: integer, available: z.boolean() }).strict();
export const assetRecoverySchema = z.object({ operationId: uuid, expectedRevision: integer, kind: z.enum(['upload', 'cleanup']), startedByMe: z.boolean() }).strict();
// Embedded-tag evidence: version 1 (stored before tag evidence v2, extended fields empty) or version 2; flagged values were left out.
const text = (max: number) => z.string().max(max).nullable(), count = integer.nullable(), names = z.array(z.string().max(200)).max(50);
const tagsSchema = z.object({ version: z.literal([1, 2]), title: text(300), album: text(300), artists: names, albumArtists: names, label: text(200), year: count, discNumber: count, trackNumber: count, durationMs: count,
  identifiers: z.object({ barcode: text(14), catalogNumber: text(100), isrc: text(12), musicBrainzReleaseId: text(36) }).strict(),
  flagged: z.array(z.object({ field: z.enum(['title', 'album', 'artists', 'albumArtists', 'label', 'barcode', 'catalogNumber', 'isrc', 'musicBrainzReleaseId']), reason: z.enum(['characters', 'length', 'format']) }).strict()).max(27) }).strict();
const common = { id, revision: integer, createdAt: z.string(), updatedAt: z.string(), startedByMe: z.boolean(), analysis: analysisSchema, upload, publication: z.enum(['notAvailable', 'notStarted', 'preparing', 'needsAttention', 'cancelled', 'complete']) };
// An import project carries Draft v2: ordered Artist entries, an optional label and per-track Disc Numbers.
export const detailSchema = z.object({ ...common, manifest: manifestSchema, draft: importDraftV2Schema,
  publicationRecovery: z.object({ operationId: uuid, cleanupPending: z.boolean(), startedByMe: z.boolean() }).strict().nullable().default(null),
  suggestions: z.array(importSuggestionV2Schema).max(1000), decisions: z.array(decisionSchema).max(122),
  assets: z.array(z.object({ slotId: z.string(), state: z.enum(['pending', 'ready', 'failed', 'unknown', 'deleting', 'cleanupFailed', 'deleted']), byteLength: integer, sha256: z.string().regex(/^[a-f0-9]{64}$/), contentType: z.string(), recovery: assetRecoverySchema.nullable().default(null), tags: tagsSchema.nullable().default(null) }).strict()).max(201).default([]),
  selectedCoverSlotId: z.string().nullable().default(null),
  // Every credited Artist in Credit order and the label Organization of a completed publication.
  published: z.object({ albumId: id, artistIds: z.array(id).min(1).max(50), organizationId: id.nullable(), trackIds: z.array(id).max(100) }).strict().nullable().default(null),
  capabilities: z.object({ analysis: z.boolean(), upload: z.boolean(), publish: z.boolean() }).strict(), receipts: z.array(receiptSchema).max(256),
  // The server's digest of what an approval confirmation shows from this saved project; a publish body echoes it.
  approvalDigest: z.string().regex(/^[a-f0-9]{64}$/),
  // Automatic writes from file tags or metadata lookup (never a revision), the paths they wrote and not yet reviewed (those resting on
  // the applied lookup candidate also in lookupPaths, so only the rest rest on file tags), and entries named like a label.
  valueRevision: integer.default(0), automaticPaths: draftPaths, lookupPaths: draftPaths, possibleLabelEntryKeys: z.array(uuid).max(20).default([])
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
export type ImportDetail = z.infer<typeof detailSchema>;
export type ImportDecision = z.infer<typeof decisionSchema>;
/**
 * The workspace buffer of one import's unsaved Review decisions, each bound to the name it was made for, and the revision of the
 * first edit (a /decisions save sends it as expectedRevision, so decisions saved since then conflict). It lives in this module,
 * which the import page, Review and the approval checklist all load already, so sharing the key moves no code between their chunks.
 */
export const duplicateEditsKey = (id: string) => `duplicate-edits:${id}`;
export interface DecisionEdits { revision: number; decisions: ImportDecision[] }
/** Whether `next` is a newer saved state than `previous`: a later revision, or the same revision with later automatic writes. */
export const newerImport = (next: Pick<ImportDetail, 'revision' | 'valueRevision'>, previous: Pick<ImportDetail, 'revision' | 'valueRevision'>) =>
  next.revision > previous.revision || next.revision === previous.revision && next.valueRevision > previous.valueRevision;
export type ImportResponse = z.infer<typeof responseSchema>;
export type WorkbenchItem = z.infer<typeof workbenchSchema>['items'][number];
export type WorkbenchFilter = typeof filters[number];
