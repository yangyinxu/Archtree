import { z } from 'zod';
import { artistEntrySchema, importDateSchema, labelEntrySchema, uuidSchema } from './adminNamingSchema';

/**
 * The strict schema of an import's metadata lookup view (GET /api/admin/v1/imports/:id/lookup), mirroring the server's allowlist
 * (src/administration/lookup/lookupView.ts): bounded candidate evidence, groups, the preselection, the applied values with their
 * conflicts and flags, and what Publish waits for. No route imports it yet; the import summary lazy-loads it, so the import page's
 * initial bundle never carries it.
 */
const integer = z.number().int().nonnegative();
const run = z.number().int().min(1);
const text = z.string().max(1000);
const candidateKey = z.string().regex(/^musicbrainz:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const releaseId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const groupKey = z.string().regex(/^[a-f0-9]{64}$/);
const trackPath = /^tracks\.([^.]+)\.(?:title|discNumber|trackNumber)$/;
/** A lookup value path: four Album values, or a file's title, Disc or Track Number. */
const valuePath = z.string().max(80).refine(path => /^album\.(?:title|artists|label|releaseDate)$/.test(path)
  || uuidSchema.safeParse(trackPath.exec(path)?.[1]).success, 'Invalid lookup path');
const slotId = uuidSchema.nullable();
const basis = z.enum(['releaseId', 'barcode', 'catalogNumber', 'onlyMatchingGroup']);

const comparisonSchema = z.object({
  trackCount: z.object({ local: integer, candidate: integer }).strict(), discCount: z.object({ local: integer.nullable(), candidate: integer }).strict(),
  differences: z.array(z.enum(['trackCount', 'discCount', 'duration'])).max(3), unknownLocalDurations: integer, unknownCandidateDurations: integer
}).strict();
const candidateSchema = z.object({
  key: candidateKey, releaseId, status: z.enum(['matching', 'unverified', 'notMatching', 'incomplete']), title: text.nullable(), artist: text.nullable(),
  label: text.nullable(), catalogNumber: text.nullable(), barcode: z.string().max(14).nullable(), country: z.string().max(2).nullable(), date: importDateSchema.nullable(),
  formats: z.array(z.string().max(100)).max(20), trackCount: integer.nullable(), comparison: comparisonSchema.nullable(), groupKey: groupKey.nullable(), artistMismatch: z.boolean().nullable()
}).strict();
/** The values a matching group would write; text is evidence and is shown, never applied from here. */
const proposalSchema = z.object({
  albumTitle: text, artists: z.array(z.object({ name: text, role: z.enum(['primary', 'featured']), joinPhrase: z.string().max(200).nullable() }).strict()).max(50),
  label: text.nullable(), releaseDate: importDateSchema.nullable(), tracks: z.array(z.object({ discNumber: integer, trackNumber: integer, title: text }).strict()).max(100)
}).strict();
const groupSchema = z.object({ groupKey, representativeKey: candidateKey, memberKeys: z.array(candidateKey).max(25), proposal: proposalSchema }).strict();
/** A conflict's lookup value in its draft form: a title, a Disc or Track Number, a date, a label or the Artist entries. */
const lookupValueSchema = z.union([z.string().max(300), z.number().int().min(1).max(9999), importDateSchema, labelEntrySchema, z.array(artistEntrySchema).max(20)]);
const appliedSchema = z.object({
  run, candidateKey: candidateKey.nullable(), releaseId: releaseId.nullable(), choice: z.enum(['preselected', 'chosen', 'none']), basis: z.union([basis, z.literal('chosen')]).nullable(),
  values: z.array(z.object({ path: valuePath, slotId }).strict()).max(305),
  conflicts: z.array(z.object({ path: valuePath, slotId, lookup: lookupValueSchema, answer: z.enum(['mine', 'lookup']).nullable() }).strict()).max(305),
  flagged: z.array(z.object({ path: valuePath, reason: z.enum(['characters', 'length', 'format', 'size', 'placeholder']) }).strict()).max(305)
}).strict();
export const lookupViewSchema = z.object({
  run, state: z.enum(['queued', 'running', 'retrying', 'complete', 'unavailable', 'stopped', 'superseded']),
  issue: z.enum(['permissionLost', 'grantExpired', 'notConfigured', 'sourceUnavailable', 'sourceBusy', 'fileSetChanged', 'projectClosed']).nullable(),
  outcome: z.enum(['candidates', 'noRelease', 'noQuery']).nullable(),
  input: z.object({ trigger: z.enum(['tags', 'folder', 'submitted']), submitted: z.object({ kind: z.enum(['album', 'song']), text }).strict().nullable() }).strict(),
  candidates: z.array(candidateSchema).max(25), groups: z.array(groupSchema).max(25),
  preselection: z.object({ candidateKey, basis, artistMismatch: z.boolean() }).strict().nullable(),
  disclosure: z.object({ unknownLocalDurations: integer, unknownLocalDiscNumbers: integer }).strict().nullable(),
  applied: appliedSchema.nullable(), staleFiles: z.array(uuidSchema).max(100),
  needsAnswer: z.object({ tie: z.boolean(), conflicts: z.array(valuePath).max(305) }).strict(), blocking: z.boolean()
}).strict();
/** The lookup view (null before any run) with the import's revision and automatic-write counter. */
export const lookupResponseSchema = z.object({ lookup: lookupViewSchema.nullable(), revision: integer, valueRevision: integer }).strict();
export type ImportLookupView = z.infer<typeof lookupViewSchema>;
export type ImportLookupResponse = z.infer<typeof lookupResponseSchema>;
