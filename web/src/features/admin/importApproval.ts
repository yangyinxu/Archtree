import type { DecisionEdits, ImportCandidate, ImportDecision, ImportDetail, ImportDraftV2 } from './adminApi';
import type { ImportDraftChange } from './importDraftPatch';

/**
 * One-step approval on the Web: the decisions a publication confirmation shows, its checklist of what becomes catalog content,
 * and the publish body bound to the saved project it was built on. Owner rules: docs/business-rules.md (Administrator Album Imports).
 */

/**
 * Decisions the confirmation shows: unsaved Review edits made at the current revision, else the saved ones; null when the edits
 * are from an older revision (Review then offers the saved decisions). Like the server's retainBoundDecisions, an Artist decision
 * stays only while its entry keeps its saved name in `draft`, a label decision only while both drafts name the same label, and an
 * Album or track decision only for an existing slot.
 */
export function shownDecisions(item: ImportDetail, draft: ImportDraftV2, edits: DecisionEdits | null): ImportDecision[] | null {
  if (edits && edits.revision !== item.revision) return null;
  const slots = new Set(item.draft.tracks.map(track => track.slotId)), savedLabel = item.draft.album.label?.name;
  return (edits?.decisions ?? item.decisions).filter(decision => {
    if (decision.scope === 'artist') {
      const saved = item.draft.album.artists.find(entry => entry.key === decision.entryKey);
      return Boolean(saved && draft.album.artists.some(entry => entry.key === saved.key && entry.name === saved.name));
    }
    if (decision.scope === 'label') return savedLabel !== undefined && draft.album.label?.name === savedLabel;
    return decision.scope === 'album' || slots.has(decision.slotId ?? '');
  });
}

/** Approved order: Disc Number (unknown counts as 1), then Track Number (unknown last), then draft order. */
export function approvalTrackOrder<T extends { discNumber: number | null; trackNumber: number | null }>(tracks: readonly T[]): T[] {
  const unknownLast = (left: number | null, right: number | null) => left === right ? 0 : left === null ? 1 : right === null ? -1 : left - right;
  return tracks.map((track, index) => ({ track, index }))
    .sort((left, right) => (left.track.discNumber ?? 1) - (right.track.discNumber ?? 1) || unknownLast(left.track.trackNumber, right.track.trackNumber) || left.index - right.index)
    .map(({ track }) => track);
}

/** What the confirmation says about one identity; needsDecision and changed block the approval. */
export type ApprovalIdentity = { kind: 'new' } | { kind: 'reused'; label: string; hidden: boolean } | { kind: 'needsDecision' } | { kind: 'changed' } | { kind: 'notApplied' };
export interface ApprovalChecklist {
  /** The Album decision reuses an existing Album: its values, entries, label and cover are not applied. */
  append: boolean;
  artists: { key: string; name: string; role: 'primary' | 'featured'; joinPhrase: string | null; identity: ApprovalIdentity }[];
  label: { name: string; identity: ApprovalIdentity } | null;
  album: ApprovalIdentity;
  /**
   * The tracks the approval adds in approved order, then the existing Album members it reuses in draft order (an append keeps a
   * member's stored title and position, so the draft's are not shown for it); skipped tracks are not catalog content and are left out.
   */
  tracks: { slotId: string; title: string; discNumber: number | null; trackNumber: number | null; existing: boolean; identity: ApprovalIdentity }[];
  blocked: number;
}
const notApplied: ApprovalIdentity = { kind: 'notApplied' };
/** A reuse is shown only while its candidate is listed at the reviewed revision; otherwise the match changed since review. */
const identityOf = (decision: ImportDecision | undefined, kind: ImportCandidate['kind'], candidates: readonly ImportCandidate[]): ApprovalIdentity => {
  if (decision?.action === 'create-distinct') return { kind: 'new' };
  if (decision?.action !== 'reuse') return { kind: 'needsDecision' };
  const candidate = candidates.find(item => item.kind === kind && item.id === decision.candidateId && item.revision === decision.candidateRevision);
  return candidate ? { kind: 'reused', label: candidate.label, hidden: candidate.visibility === 'hidden' } : { kind: 'changed' };
};
/** The confirmation checklist of `draft` with the decisions it shows (shownDecisions) and the current duplicate candidates. */
export function approvalChecklist(draft: ImportDraftV2, decisions: readonly ImportDecision[], candidates: readonly ImportCandidate[]): ApprovalChecklist {
  const albumDecision = decisions.find(decision => decision.scope === 'album'), append = albumDecision?.action === 'reuse';
  const artists = draft.album.artists.map(({ key, name, role, joinPhrase }) => ({ key, name, role, joinPhrase,
    identity: append ? notApplied : identityOf(decisions.find(decision => decision.scope === 'artist' && decision.entryKey === key), 'artist', candidates) }));
  const label = draft.album.label && { name: draft.album.label.name, identity: append ? notApplied : identityOf(decisions.find(decision => decision.scope === 'label'), 'organization', candidates) };
  const album = identityOf(albumDecision, 'album', candidates);
  const listed = draft.tracks.flatMap(({ slotId, title, discNumber, trackNumber }) => {
    const decision = decisions.find(item => item.scope === 'track' && item.slotId === slotId);
    return decision?.action === 'skip' ? [] : [{ slotId, title, discNumber, trackNumber, existing: decision?.action === 'reuse', identity: identityOf(decision, 'track', candidates) }];
  });
  const tracks = [...approvalTrackOrder(listed.filter(track => !track.existing)), ...listed.filter(track => track.existing)];
  const blocked = [...artists.map(entry => entry.identity), ...(label ? [label.identity] : []), album, ...tracks.map(track => track.identity)]
    .filter(identity => identity.kind === 'needsDecision' || identity.kind === 'changed').length;
  return { append, artists, label, album, tracks, blocked };
}

/** The publish body: the shown unsaved changes, decisions and saved cover, bound to the saved project by its revision and digest. */
export function approvalBody(item: ImportDetail, changes: ImportDraftChange[], decisions: ImportDecision[]) {
  return { expectedRevision: item.revision, changes, decisions, selectedCoverSlotId: item.selectedCoverSlotId, approvalDigest: item.approvalDigest };
}
export type ApprovalBody = ReturnType<typeof approvalBody>;
