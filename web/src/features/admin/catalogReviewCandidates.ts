import type { ReviewCandidate } from './catalogReviewLookupApi';

/**
 * The review identity rows' copy of the import's candidate matching (importIdentity.ts, rowCandidates), which it must keep equal
 * to; kept apart so the import identity module stays in the import page's chunks.
 */

/** The server's case folding (NFC, then locale-independent lower case), so a Turkish browser locale matches as the server does. */
export const sameName = (left: string, right: string) => left.normalize('NFC').toLowerCase() === right.normalize('NFC').toLowerCase();
/**
 * An Artist's or label Organization's candidates: by name, by the MusicBrainz ID it carries, by a name lookup found for that ID, or
 * by an iTunes localized name lookup found for its name.
 */
export const reviewRowCandidates = (kind: ReviewCandidate['kind'], name: string, musicBrainzId: string | null, items: readonly ReviewCandidate[]) =>
  items.filter(item => item.kind === kind && (sameName(item.label, name) || (musicBrainzId !== null && (item.musicBrainzId === musicBrainzId || item.aliasOf === musicBrainzId))
    || (item.localizedOf !== undefined && sameName(item.localizedOf, name))));
