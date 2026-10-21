import { z } from 'zod';
import { creditRoles } from './catalogApi';
import { uuidSchema } from './adminNamingSchema';
import { reviewLookupViewSchema, reviewValuePathSchema } from './importLookupApi';

/**
 * The strict schemas of an existing-Album review's lookup summary (GET /catalog-reviews/:id/lookup) and identity read
 * (GET /catalog-reviews/:id/candidates), mirroring the server's CatalogReviewLookupResponse
 * (src/administration/lookup/catalogReviewLookupRequests.ts) and CatalogReviewIdentityResponse
 * (src/administration/catalog/adminCatalogReviewContract.ts). Only ever loaded with those reads, so the review page's own chunk
 * carries none of it.
 */
const integer = z.number().int().nonnegative();
const id = z.string().regex(/^[a-f0-9]{24}$/);
const mbid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const name = z.string().max(200);
const scope = z.enum(['artist', 'label']);
const creditId = z.string().regex(/^[A-Za-z0-9_-]{8,100}$/);

/** What the review waits for (a lookup run or Luna analysis), the answers lookup needs, and whether this server offers lookup. */
const reviewSummarySchema = z.object({
  waiting: z.object({ lookup: z.boolean(), analysis: z.boolean() }).strict(),
  needsAnswer: z.object({ tie: z.boolean(), conflicts: z.array(reviewValuePathSchema).max(406) }).strict(), lookupAvailable: z.boolean()
}).strict();
/**
 * The review's lookup view (null before any run), its revision, its value revision and its summary; lookup applications never
 * change `revision`, only `valueRevision`.
 */
export const reviewLookupResponseSchema = z.object({ lookup: reviewLookupViewSchema.nullable(), revision: integer, valueRevision: integer, summary: reviewSummarySchema }).strict();

/** A stored identity decision: the name and MusicBrainz ID it was made for, and reuse, create or reuse-and-replace-the-ID. */
const decision = z.object({ scope, identity: uuidSchema.nullable(), boundName: name, boundMusicBrainzId: mbid.nullable(), action: z.enum(['reuse', 'create-distinct', 'replace']),
  candidateId: id.nullable(), candidateRevision: revision.nullable() }).strict();
/** A preselection an apply of the default selection must show: reuse of a candidate, or create. */
const preselection = z.object({ scope, identity: uuidSchema.nullable(), boundName: name, action: z.enum(['reuse', 'create-distinct']), candidateId: id.nullable(),
  candidateRevision: revision.nullable() }).strict();
/** A MusicBrainz ID an apply records (`replaces` null) or puts in place of another. */
const idWrite = z.object({ scope, identity: uuidSchema.nullable(), musicBrainzId: mbid, replaces: mbid.nullable() }).strict();
/** A record entries or the label are bound to, at its captured revision. */
const bound = z.object({ id, name, musicBrainzId: mbid.nullable(), revision, visibility: z.enum(['public', 'hidden']) }).strict();
/** One current or new Credit: no Credit ID for one still to be created, no subject for a record still to be created or decided. */
const creditView = z.object({ creditId: creditId.nullable(), subjectType: z.enum(['artist', 'organization']), subjectId: id.nullable(),
  identity: uuidSchema.nullable(), name: z.string().max(1000), role: z.enum(creditRoles), joinPhrase: z.string().min(1).max(16).nullable() }).strict();
/** An Artist entry an identity covers: the Album's (`slotId` null) or a member's. */
const entry = z.object({ path: z.string().regex(/^(?:album|tracks\.[^.]+)\.artists$/).refine(path => path === 'album.artists' || uuidSchema.safeParse(path.split('.')[1]).success),
  slotId: uuidSchema.nullable(), entryKey: uuidSchema, name, role: z.enum(['primary', 'featured']) }).strict();
/**
 * One Artist identity of the default selection: every entry it covers (the Album's 20 and 20 per member), the other names credited
 * for it, its state and bound records, and the decision, preselection and ID write that answer it.
 */
const identity = z.object({ id: uuidSchema, name, musicBrainzId: mbid.nullable(), names: z.array(name).max(2020), entries: z.array(entry).max(2020),
  state: z.enum(['bound', 'conflicting', 'unbound']), bound: z.array(bound).max(2020), decision: decision.nullable(), preselection: preselection.nullable(),
  needsAnswer: z.boolean(), musicBrainzIdWrite: idWrite.nullable() }).strict();
const label = z.object({ name, musicBrainzId: mbid.nullable(), state: z.enum(['bound', 'unbound']), bound: bound.nullable(), decision: decision.nullable(),
  preselection: preselection.nullable(), needsAnswer: z.boolean(), musicBrainzIdWrite: idWrite.nullable() }).strict();
/**
 * One Artist or Organization candidate: the import candidate item (`candidatesSchema` in importIdentity.ts) narrowed to those kinds,
 * kept here so the import identity module stays in the import page's chunks.
 */
const candidate = z.object({ kind: z.enum(['artist', 'organization']), id, label: z.string(), revision: z.string(), albumId: id.nullable(), visibility: z.enum(['public', 'hidden']),
  match: z.enum(['name', 'sha256', 'musicBrainzId', 'alias', 'localizedName']), matchedSlotIds: z.array(uuidSchema).max(100), automaticReuse: z.literal(false),
  musicBrainzId: mbid.optional(), aliasOf: mbid.optional(), localizedOf: z.string().max(200).optional() }).strict();
/**
 * An owner's current and new Credits. The current list is the stored one; new ones hold the stored Credits and up to 20 entries
 * placed ahead of them when none were replaced, and the Album also a new label Credit (71); a member has no label (70).
 */
const credits = (next: number) => ({ current: z.array(creditView).max(70), next: z.array(creditView).max(next), credits: z.boolean() });
/** The identity rows, candidates, preselections, ID writes and Credit changes of the review's default selection. */
export const reviewIdentitySchema = z.object({
  revision: integer, valueRevision: integer, identities: z.array(identity).max(512), label: label.nullable(),
  // 20 per name of 513 identities and the label, one holder per ID, 20 per alias ID and 20 per localized name of the 512 identities.
  candidates: z.object({ items: z.array(candidate).max(31_273), unavailable: z.array(z.object({ kind: z.enum(['artist', 'organization']), label: z.string() }).strict()).max(513) }).strict(),
  preselections: z.array(preselection).max(513), musicBrainzIds: z.array(idWrite).max(513),
  album: z.object({ ...credits(71), replacedPrimaryArtistIds: z.array(id).max(50), membersNamingReplaced: z.array(uuidSchema).max(100) }).strict().nullable(),
  members: z.array(z.object({ slotId: uuidSchema, ...credits(70), removedCreditIds: z.array(creditId).max(50),
    attribution: z.object({ from: z.enum(['documented', 'unknown']).nullable(), to: z.literal('documented') }).strict().nullable() }).strict()).max(100)
}).strict();

export type ReviewLookupResponse = z.infer<typeof reviewLookupResponseSchema>;
export type ReviewIdentityResponse = z.infer<typeof reviewIdentitySchema>;
export type ReviewCandidate = ReviewIdentityResponse['candidates']['items'][number];
/** One item of POST /catalog-reviews/:id/decisions: exactly the six keys the server parses. */
export type ReviewDecisionItem = { scope: 'artist' | 'label'; identity: string | null; boundName: string; action: 'reuse' | 'create-distinct' | 'replace'; candidateId: string | null;
  candidateRevision: string | null };
