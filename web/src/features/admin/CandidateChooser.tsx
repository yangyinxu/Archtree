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
/** The value text of one proposal field; with `ids`, Artist entries and the label also name their MusicBrainz ID (`withId`). */
const proposalText = (field: typeof fields[number], proposal: Proposal, withId?: (text: string, id: string | null) => string) => field === 'artists'
  ? (withId ? proposal.artists.map(entry => withId(entry.name, entry.musicBrainzId)).join(' · ') : entriesByline(proposal.artists)) || '—'
  : field === 'tracks' ? proposal.tracks.map(track => `${track.discNumber}.${track.trackNumber} ${track.title}`).join(' · ') || '—'
  : field === 'releaseDate' ? reviewValueText(proposal.releaseDate) : field === 'label' && withId && proposal.label ? withId(proposal.label, proposal.labelMusicBrainzId) : proposal[field] || '—';

/**
 * Chooses a release of the current lookup run, or none. While several matching groups tie, it lists each group's representative
 * with only the values that differ between the groups, plus its barcode, catalogue number, country and medium, and needs an
 * answer. The only matching group of a partial comparison, never applied unasked, is offered the same way with every value but
 * needs no answer. Every candidate also stays selectable in a folded list, a non-matching one showing how it differs from the
 * files. Files whose duration or Disc Number is unknown are disclosed, since ranking never counts them as agreement, and so is a
 * comparison that did not include every release MusicBrainz found. Choosing applies at once (POST /lookup/choose); a release
 * applied as a preselection stays choosable while a tie needs an answer.
 */
export function CandidateChooser({ lookup, disabled, onChoose }: { lookup: ImportLookupView; disabled: boolean; onChoose: (candidateKey: string | null) => void }) {
  const t = useAdminText(), id = useId(), tie = lookup.needsAnswer.tie, single = lookup.groups.length === 1;
  const offered = !tie && single && !lookup.preselection && lookup.disclosure?.partialComparison === true && lookup.applied?.run !== lookup.run;
  const chosen = lookup.applied?.run === lookup.run && !(tie && lookup.applied.choice === 'preselected') ? lookup.applied.candidateKey : undefined;
  // A label differs also by its MusicBrainz ID; groups whose entries or label differ only by ID show each ID.
  const valueOf = (proposal: Proposal, field: typeof fields[number]) => JSON.stringify(field === 'label' ? [proposal.label, proposal.labelMusicBrainzId] : proposal[field]);
  const differing = single ? [...fields] : fields.filter(field => new Set(lookup.groups.map(group => valueOf(group.proposal, field))).size > 1);
  const byId = (field: typeof fields[number]) => !single && (field === 'artists' || field === 'label') && new Set(lookup.groups.map(group => proposalText(field, group.proposal))).size === 1;
  const withId = (text: string, musicBrainzId: string | null) => musicBrainzId ? `${text} · ${t('lookup.musicbrainz_id', { id: musicBrainzId })}` : text;
  const representatives = lookup.groups.flatMap(group => lookup.candidates.filter(candidate => candidate.key === group.representativeKey).map(candidate => ({ candidate, proposal: group.proposal })));
  const fact = (key: string, value: string | null) => <div key={key}><dt>{t(key)}</dt><dd>{value || '—'}</dd></div>;
  // The tie view lists each group's representative with its proposal; the folded list every candidate with its status.
  const list = (prefix: string, shown: { candidate: Candidate; proposal: Proposal | null }[]) => <ul className={styles.cards}>{shown.map(({ candidate, proposal }, index) => {
    const comparison = candidate.comparison;
    return <li key={candidate.key} className={styles.card}>
      <strong id={`${id}-${prefix}${index}`}>{[candidate.title ?? '—', candidate.artist].filter(Boolean).join(' · ')}</strong>
      {!proposal && <p className={styles.muted}>{[t(`lookup.status_${candidate.status}`), candidate.label, reviewValueText(candidate.date), candidate.trackCount === null ? null : t('lookup.track_count', { count: candidate.trackCount })].filter(Boolean).join(' · ')}</p>}
      <dl>
        {proposal && differing.map(field => fact(fieldKeys[field], proposalText(field, proposal, byId(field) ? withId : undefined)))}
        {fact('lookup.barcode', candidate.barcode)}{fact('lookup.catalog_number', candidate.catalogNumber)}{fact('lookup.country', candidate.country)}{fact('lookup.medium', candidate.formats.join(', '))}
      </dl>
      {comparison && candidate.status === 'notMatching' && <ul>{comparison.differences.map(difference => <li key={difference}>{t(`lookup.difference_${difference}`, difference === 'discCount'
        ? { local: String(comparison.discCount.local ?? '—'), candidate: String(comparison.discCount.candidate) } : { local: String(comparison.trackCount.local), candidate: String(comparison.trackCount.candidate) })}</li>)}</ul>}
      <button type="button" className={styles.button} disabled={disabled || chosen === candidate.key} aria-describedby={`${id}-${prefix}${index}`} onClick={() => onChoose(candidate.key)}>{t(chosen === candidate.key ? 'lookup.chosen' : 'lookup.choose')}</button>
    </li>;
  })}</ul>;
  const disclosure = lookup.disclosure, unknown = disclosure ? ([['lookup.unknown_durations', disclosure.unknownLocalDurations], ['lookup.unknown_discs', disclosure.unknownLocalDiscNumbers]] as const).filter(([, count]) => count > 0) : [];
  const disclosed = [...unknown.map(([key, count]) => <p key={key} className={styles.muted}>{t(key, { count })}</p>),
    disclosure?.partialComparison && <p key="partial" className={styles.muted}>{t('lookup.partial_comparison')}</p>];
  const none = <div className={styles.actions}><button type="button" className={styles.button} disabled={disabled || (chosen === null && lookup.applied?.choice === 'none')} onClick={() => onChoose(null)}>{t('lookup.choose_none')}</button></div>;
  const all = <details className={styles.details}><summary>{t('lookup.candidates', { count: lookup.candidates.length })}</summary>{list('a', lookup.candidates.map(candidate => ({ candidate, proposal: null })))}{!tie && !offered && none}</details>;
  return tie || offered ? <><section aria-labelledby={`${id}-tie`}><h3 id={`${id}-tie`}>{t(tie ? 'lookup.tie' : 'lookup.single_choice')}</h3>{disclosed}{list('t', representatives)}{none}</section>{all}</> : <>{disclosed}{all}</>;
}
