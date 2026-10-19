import { z } from 'zod';
import type { ImportDecision, ImportDraftV2 } from './adminApi';

/**
 * Identity candidates and the preselections Review and the publication confirmation show; the server mirror is
 * src/administration/import/adminImportIdentity.ts, which recomputes them at approval. Loaded only by those lazy chunks, never
 * by the import page itself. Owner rules: docs/business-rules.md (Administrator Album Imports).
 */
const id = z.string().regex(/^[a-f0-9]{24}$/), uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
/**
 * At most 20 candidates per Artist entry name (20 entries) and 20 each for the label, the Album and the track titles, one verified
 * byte match per staged file (100), plus at most 300 byte or title matches among Album members: 860. A response without
 * `memberMatchesComplete` counts as incomplete, so no append file is preselected from it. `unavailable` names the entries, the
 * label or the Album title (at most 22) whose same-name record is malformed: never a candidate, yet never preselected over.
 */
export const candidatesSchema = z.object({
  items: z.array(z.object({ kind: z.enum(['artist', 'organization', 'album', 'track']), id, label: z.string(), revision: z.string(), albumId: id.nullable(), visibility: z.enum(['public', 'hidden']),
    match: z.enum(['name', 'sha256']), matchedSlotIds: z.array(uuid).max(100), automaticReuse: z.literal(false) }).strict()).max(860),
  memberMatchesComplete: z.boolean().default(false),
  unavailable: z.array(z.object({ kind: z.enum(['artist', 'organization', 'album']), label: z.string() }).strict()).max(22).default([])
}).strict();
export type ImportCandidates = z.infer<typeof candidatesSchema>;
export type ImportCandidate = ImportCandidates['items'][number];

/** The server's case folding (NFC, then locale-independent lower case), so a Turkish browser locale matches as the server does. */
export const sameName = (left: string, right: string) => left.normalize('NFC').toLowerCase() === right.normalize('NFC').toLowerCase();
const choice = (scope: ImportDecision['scope'], slotId: string | null, entryKey: string | null, boundName: string | null, reused?: ImportCandidate): ImportDecision =>
  ({ scope, slotId, entryKey, boundName, action: reused ? 'reuse' : 'create-distinct', candidateId: reused?.id ?? null, candidateRevision: reused?.revision ?? null });

/**
 * The decisions preselected for rows of `draft` without an explicit decision in `decisions`, from `candidates` read for the saved
 * draft `saved`. A row whose shown name differs from its saved one (an entry by key, the label, the Album title and, in an
 * append, a track title) is never preselected: its candidates were not read for that name. Otherwise as on the server: without
 * an explicit Album reuse, an entry, the label and the Album with no name candidate of their kind are created, and once the
 * Album is created so is every track; when appending, a file matching no target member is a new member, and one whose verified
 * bytes match exactly one member, matched by no other file and reused by no other decision, reuses it, all only while the member
 * matches are complete. A name listed as `unavailable` counts as a candidate. Any other row needs an explicit choice.
 */
export function identityPreselections(draft: ImportDraftV2, saved: ImportDraftV2, decisions: readonly ImportDecision[], candidates: ImportCandidates): ImportDecision[] {
  const { items, unavailable } = candidates, result: ImportDecision[] = [], album = decisions.find(decision => decision.scope === 'album');
  const listed = (kind: ImportCandidate['kind'], name: string) => items.some(item => item.kind === kind && sameName(item.label, name)) || unavailable.some(entry => entry.kind === kind && sameName(entry.label, name));
  const decided = (slotId: string) => decisions.some(decision => decision.scope === 'track' && decision.slotId === slotId);
  if (album?.action === 'reuse') {
    if (!candidates.memberMatchesComplete) return result;
    const reused = new Set(decisions.filter(decision => decision.scope === 'track' && decision.action === 'reuse').map(decision => decision.candidateId));
    for (const track of draft.tracks) {
      if (decided(track.slotId) || saved.tracks.find(item => item.slotId === track.slotId)?.title !== track.title) continue;
      const bytes = (item: ImportCandidate) => item.match === 'sha256' && item.matchedSlotIds.includes(track.slotId);
      const members = items.filter(item => item.kind === 'track' && item.albumId === album.candidateId && (bytes(item) || (track.title !== '' && sameName(item.label, track.title))));
      const identical = members.filter(bytes);
      if (!members.length) result.push(choice('track', track.slotId, null, null));
      else if (identical.length === 1 && identical[0].matchedSlotIds.length === 1 && !reused.has(identical[0].id)) result.push(choice('track', track.slotId, null, null, identical[0]));
    }
    return result;
  }
  for (const entry of draft.album.artists) {
    if (!decisions.some(decision => decision.scope === 'artist' && decision.entryKey === entry.key) && saved.album.artists.find(item => item.key === entry.key)?.name === entry.name
      && !listed('artist', entry.name)) result.push(choice('artist', null, entry.key, entry.name));
  }
  const label = draft.album.label;
  if (label && !decisions.some(decision => decision.scope === 'label') && saved.album.label?.name === label.name && !listed('organization', label.name)) result.push(choice('label', null, null, label.name));
  const created = album ? album.action === 'create-distinct' : draft.album.title === saved.album.title && !listed('album', draft.album.title);
  if (!album && created) result.push(choice('album', null, null, null));
  if (created) for (const track of draft.tracks) if (!decided(track.slotId)) result.push(choice('track', track.slotId, null, null));
  return result;
}

/**
 * Slots whose verified bytes match a ready MediaTrack outside the explicit append target (another Album, or none): a possible
 * duplicate that is flagged and never collapsed, but needs no answer and changes no preselection.
 */
export function duplicateFileSlots(decisions: readonly ImportDecision[], candidates: ImportCandidates): ReadonlySet<string> {
  const target = decisions.find(decision => decision.scope === 'album' && decision.action === 'reuse')?.candidateId ?? null;
  return new Set(candidates.items.filter(item => item.kind === 'track' && item.match === 'sha256' && (item.albumId === null || item.albumId !== target)).flatMap(item => item.matchedSlotIds));
}
