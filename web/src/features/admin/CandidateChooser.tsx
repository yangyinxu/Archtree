import { useEffect, useId, useRef, useState } from 'react';
import { useAdminText } from './AdminAccess';
import { entriesByline } from './artistEntriesByline';
import type { ImportLookupView } from './importLookupApi';
import { reviewValueText } from './reviewValueText';
import styles from './adminStyles';

type Candidate = ImportLookupView['candidates'][number];
type Proposal = ImportLookupView['groups'][number]['proposal'];
/**
 * A preview's progress by candidate key: none yet waits for its first turn, `loading` holds one of the PREVIEWS_AT_ONCE turns,
 * `cooling` waits RETRY_MS after a failure, `retry` waits for its one more turn (`reloading`), and `hidden` failed twice.
 */
type Preview = 'loading' | 'loaded' | 'cooling' | 'retry' | 'reloading' | 'hidden';
/** At most this many previews load at once, as Cover Art Archive serves two; a failed one is tried once more after RETRY_MS. */
const PREVIEWS_AT_ONCE = 2, RETRY_MS = 2_000;
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
 * applied as a preselection stays choosable while a tie needs an answer. A candidate whose release reports front artwork shows it
 * through the protected administrator preview, never from a lookup address: once per release (in the tie or offered view when it
 * represents a group there, else in the folded list, and there only once the list is opened), at most two loading at a time in the
 * order shown, and a preview that fails is tried once more after two seconds, then hidden.
 */
export function CandidateChooser({ importId, viewerId, lookup, disabled, onChoose }: { importId: string; viewerId: string; lookup: ImportLookupView; disabled: boolean; onChoose: (candidateKey: string | null) => void }) {
  const t = useAdminText(), id = useId(), tie = lookup.needsAnswer.tie, single = lookup.groups.length === 1;
  const [previews, setPreviews] = useState<ReadonlyMap<string, Preview>>(() => new Map()), [foldedOpen, setFoldedOpen] = useState(false);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => { const pending = timers.current; return () => pending.forEach(clearTimeout); }, []);
  const mark = (key: string, from: Preview, to: Preview) => setPreviews(previous => previous.get(key) === from ? new Map(previous).set(key, to) : previous);
  const failed = (key: string) => {
    if (previews.get(key) !== 'loading') return mark(key, 'reloading', 'hidden');
    mark(key, 'loading', 'cooling');
    const timer = setTimeout(() => { timers.current.delete(timer); mark(key, 'cooling', 'retry'); }, RETRY_MS); timers.current.add(timer);
  };
  const offered = !tie && single && !lookup.preselection && lookup.disclosure?.partialComparison === true && lookup.applied?.run !== lookup.run;
  const chosen = lookup.applied?.run === lookup.run && !(tie && lookup.applied.choice === 'preselected') ? lookup.applied.candidateKey : undefined;
  // A label differs also by its MusicBrainz ID; groups whose entries or label differ only by ID show each ID.
  const valueOf = (proposal: Proposal, field: typeof fields[number]) => JSON.stringify(field === 'label' ? [proposal.label, proposal.labelMusicBrainzId] : proposal[field]);
  const differing = single ? [...fields] : fields.filter(field => new Set(lookup.groups.map(group => valueOf(group.proposal, field))).size > 1);
  const byId = (field: typeof fields[number]) => !single && (field === 'artists' || field === 'label') && new Set(lookup.groups.map(group => proposalText(field, group.proposal))).size === 1;
  const withId = (text: string, musicBrainzId: string | null) => musicBrainzId ? `${text} · ${t('lookup.musicbrainz_id', { id: musicBrainzId })}` : text;
  const representatives = lookup.groups.flatMap(group => lookup.candidates.filter(candidate => candidate.key === group.representativeKey).map(candidate => ({ candidate, proposal: group.proposal })));
  // Each release's preview appears once, in the order shown (the folded list's once it is opened).
  const above = tie || offered ? representatives.map(({ candidate }) => candidate.key) : [];
  const order = [...above, ...(foldedOpen ? lookup.candidates.map(candidate => candidate.key).filter(key => !above.includes(key)) : [])]
    .filter(key => lookup.candidates.some(candidate => candidate.key === key && candidate.artwork)).join(' ');
  // Turns go to the first waiting previews shown; one no longer shown gives its turn back and waits again.
  useEffect(() => setPreviews(previous => {
    const next = new Map(previous), keys = order ? order.split(' ') : [];
    for (const [key, state] of previous) if (!keys.includes(key) && state === 'loading') next.delete(key); else if (!keys.includes(key) && state === 'reloading') next.set(key, 'retry');
    let busy = keys.filter(key => next.get(key) === 'loading' || next.get(key) === 'reloading').length;
    for (const key of keys) if (busy < PREVIEWS_AT_ONCE && (!next.has(key) || next.get(key) === 'retry')) { next.set(key, next.has(key) ? 'reloading' : 'loading'); busy++; }
    return next.size !== previous.size || [...next].some(([key, state]) => previous.get(key) !== state) ? next : previous;
  }), [order, previews]);
  // A failed preview leaves the page while it cools, so its retry is a new image element.
  const artwork = (candidate: Candidate, folded: boolean) => candidate.artwork && folded !== above.includes(candidate.key)
    && ['loading', 'reloading', 'loaded'].includes(previews.get(candidate.key)!) && <img decoding="async" width={64} height={64} alt={t('lookup.artwork_preview')}
      src={`/api/admin/v1/imports/${importId}/lookup/candidates/${encodeURIComponent(candidate.key)}/artwork?viewer=${encodeURIComponent(viewerId)}`}
      onLoad={() => mark(candidate.key, previews.get(candidate.key)!, 'loaded')} onError={() => failed(candidate.key)} />;
  const fact = (key: string, value: string | null) => <div key={key}><dt>{t(key)}</dt><dd>{value || '—'}</dd></div>;
  // The tie view lists each group's representative with its proposal; the folded list every candidate with its status.
  const list = (prefix: string, shown: { candidate: Candidate; proposal: Proposal | null }[]) => <ul className={styles.cards}>{shown.map(({ candidate, proposal }, index) => {
    const comparison = candidate.comparison;
    return <li key={candidate.key} className={styles.card}>
      {artwork(candidate, prefix === 'a')}
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
  const all = <details className={styles.details} onToggle={event => setFoldedOpen(event.currentTarget.open)}><summary>{t('lookup.candidates', { count: lookup.candidates.length })}</summary>{list('a', lookup.candidates.map(candidate => ({ candidate, proposal: null })))}{!tie && !offered && none}</details>;
  return tie || offered ? <><section aria-labelledby={`${id}-tie`}><h3 id={`${id}-tie`}>{t(tie ? 'lookup.tie' : 'lookup.single_choice')}</h3>{disclosed}{list('t', representatives)}{none}</section>{all}</> : <>{disclosed}{all}</>;
}
