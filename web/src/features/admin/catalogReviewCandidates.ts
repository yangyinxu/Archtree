import type { MessageVariables } from '../../localization/contract';
import type { ReviewCandidate } from './catalogReviewLookupApi';

/**
 * The review identity rows' copies of the import's candidate matching and option text (importIdentity.ts), which they must keep
 * equal to; kept apart so the import identity module stays in the import page's chunks.
 */

/** The server's case folding (NFC, then locale-independent lower case), so a Turkish browser locale matches as the server does. */
const sameName = (left: string, right: string) => left.normalize('NFC').toLowerCase() === right.normalize('NFC').toLowerCase();
/**
 * An Artist's or label Organization's candidates: by name, by the MusicBrainz ID it carries, by a name lookup found for that ID, or
 * by an iTunes localized name lookup found for its name.
 */
export const reviewRowCandidates = (kind: ReviewCandidate['kind'], name: string, musicBrainzId: string | null, items: readonly ReviewCandidate[]) =>
  items.filter(item => item.kind === kind && (sameName(item.label, name) || (musicBrainzId !== null && (item.musicBrainzId === musicBrainzId || item.aliasOf === musicBrainzId))
    || (item.localizedOf !== undefined && sameName(item.localizedOf, name))));
/**
 * A reuse option's text: the candidate's name, how it matched, its visibility, the MusicBrainz ID it keeps when reusing it keeps
 * one other than the row's (`keptId`), and the end of its ID so same-name records stay distinguishable.
 */
export const reviewCandidateText = (t: (key: string, variables?: MessageVariables) => string, candidate: ReviewCandidate, keptId: string | null) =>
  [t('duplicates.reuse'), candidate.label, t(`duplicates.${candidate.match}`), t(`field.${candidate.visibility}`), keptId && t('duplicates.keeps_id', { id: keptId }),
    candidate.id.slice(-6)].filter(Boolean).join(' · ');
