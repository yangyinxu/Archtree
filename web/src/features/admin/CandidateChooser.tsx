import { useId } from 'react';
import { useAdminText } from './AdminAccess';
import { entriesByline } from './artistEntriesByline';
import type { ImportLookupView } from './importLookupApi';
import { reviewValueText } from './reviewValueText';
import styles from './adminStyles';

type Candidate = ImportLookupView['candidates'][number];
type Proposal = ImportLookupView['groups'][number]['proposal'];
const fields = ['albumTitle', 'artists', 'label', 'releaseDate', 'tracks'] as const;
const fieldKeys = { albumTitle: 'field.title', artists: 'field.artists', label: 'field.label', releaseDate: 'field.release_date', tracks: 'summary.tracks' } as const;
const proposalText = (field: typeof fields[number], proposal: Proposal) => field === 'artists' ? entriesByline(proposal.artists) || '—'
  : field === 'tracks' ? proposal.tracks.map(track => `${track.discNumber}.${track.trackNumber} ${track.title}`).join(' · ') || '—'
  : field === 'releaseDate' ? reviewValueText(proposal.releaseDate) : proposal[field] || '—';

/**
 * Chooses a release of the current lookup run, or none. While several matching groups tie, it lists each group's representative
 * with only the values that differ between the groups, plus its barcode, catalogue number, country and medium, and needs an
 * answer. Every candidate also stays selectable in a folded list, a non-matching one showing how it differs from the files.
 * Files whose duration or Disc Number is unknown are disclosed, since ranking never counts them as agreement. Choosing applies
 * at once (POST /lookup/choose).
 */
export function CandidateChooser({ lookup, disabled, onChoose }: { lookup: ImportLookupView; disabled: boolean; onChoose: (candidateKey: string | null) => void }) {
  const t = useAdminText(), id = useId(), tie = lookup.needsAnswer.tie;
  const chosen = lookup.applied?.run === lookup.run ? lookup.applied.candidateKey : undefined;
  const differing = fields.filter(field => new Set(lookup.groups.map(group => JSON.stringify(group.proposal[field]))).size > 1);
  const representatives = lookup.groups.flatMap(group => lookup.candidates.filter(candidate => candidate.key === group.representativeKey).map(candidate => ({ candidate, proposal: group.proposal })));
  const fact = (key: string, value: string | null) => <div key={key}><dt>{t(key)}</dt><dd>{value || '—'}</dd></div>;
  // The tie view lists each group's representative with its proposal; the folded list every candidate with its status.
  const list = (prefix: string, shown: { candidate: Candidate; proposal: Proposal | null }[]) => <ul className={styles.cards}>{shown.map(({ candidate, proposal }, index) => {
    const comparison = candidate.comparison;
    return <li key={candidate.key} className={styles.card}>
      <strong id={`${id}-${prefix}${index}`}>{[candidate.title ?? '—', candidate.artist].filter(Boolean).join(' · ')}</strong>
      {!proposal && <p className={styles.muted}>{[t(`lookup.status_${candidate.status}`), candidate.label, reviewValueText(candidate.date), candidate.trackCount === null ? null : t('lookup.track_count', { count: candidate.trackCount })].filter(Boolean).join(' · ')}</p>}
      <dl>
        {proposal && differing.map(field => fact(fieldKeys[field], proposalText(field, proposal)))}
        {fact('lookup.barcode', candidate.barcode)}{fact('lookup.catalog_number', candidate.catalogNumber)}{fact('lookup.country', candidate.country)}{fact('lookup.medium', candidate.formats.join(', '))}
      </dl>
      {comparison && candidate.status === 'notMatching' && <ul>{comparison.differences.map(difference => <li key={difference}>{t(`lookup.difference_${difference}`, difference === 'discCount'
        ? { local: String(comparison.discCount.local ?? '—'), candidate: String(comparison.discCount.candidate) } : { local: String(comparison.trackCount.local), candidate: String(comparison.trackCount.candidate) })}</li>)}</ul>}
      <button type="button" className={styles.button} disabled={disabled || chosen === candidate.key} aria-describedby={`${id}-${prefix}${index}`} onClick={() => onChoose(candidate.key)}>{t(chosen === candidate.key ? 'lookup.chosen' : 'lookup.choose')}</button>
    </li>;
  })}</ul>;
  const disclosure = lookup.disclosure, unknown = disclosure ? ([['lookup.unknown_durations', disclosure.unknownLocalDurations], ['lookup.unknown_discs', disclosure.unknownLocalDiscNumbers]] as const).filter(([, count]) => count > 0) : [];
  const disclosed = unknown.map(([key, count]) => <p key={key} className={styles.muted}>{t(key, { count })}</p>);
  const none = <div className={styles.actions}><button type="button" className={styles.button} disabled={disabled || (chosen === null && lookup.applied?.choice === 'none')} onClick={() => onChoose(null)}>{t('lookup.choose_none')}</button></div>;
  const all = <details className={styles.details}><summary>{t('lookup.candidates', { count: lookup.candidates.length })}</summary>{list('a', lookup.candidates.map(candidate => ({ candidate, proposal: null })))}{!tie && none}</details>;
  return tie ? <><section aria-labelledby={`${id}-tie`}><h3 id={`${id}-tie`}>{t('lookup.tie')}</h3>{disclosed}{list('t', representatives)}{none}</section>{all}</> : <>{disclosed}{all}</>;
}
