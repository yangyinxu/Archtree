import { useId } from 'react';
import type { ImportDetail, ImportDraft, ImportSuggestion } from './adminApi';
import { useAdminText } from './AdminAccess';
import styles from './adminStyles';
import { reviewValueText } from './reviewValueText';

export { reviewValueText } from './reviewValueText';

export const suggestionValue = (draft: ImportDraft, suggestion: ImportSuggestion) => suggestion.scope === 'album'
  ? draft.album[suggestion.field as keyof ImportDraft['album']]
  : draft.tracks.find(track => track.slotId === suggestion.slotId)?.[suggestion.field as 'title' | 'trackNumber'];
export const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** A changed baseline cannot be force-adopted; the administrator can edit or reject it explicitly. */
export function ImportReview({ draft, suggestions, selected, onSelect, onAdopt, onReject, disabled, filenames }: {
  draft: ImportDraft; suggestions: ImportSuggestion[]; selected: string[]; onSelect: (ids: string[]) => void;
  onAdopt: (ids: string[]) => void; onReject: (ids: string[]) => void; disabled: boolean; filenames?: ImportDetail['manifest']['files'];
}) {
  const t = useAdminText();
  const contextId = useId();
  const pending = suggestions.filter(item => item.decision === 'pending');
  const eligible = pending.filter(item => sameValue(suggestionValue(draft, item), item.baseline));
  const allowed = selected.filter(id => eligible.some(item => item.id === id));
  return <section className={styles.panel}>
    <header className={styles.sectionHeader}><div><h2>{t('review.title')}</h2><p className={styles.muted}>{t('review.draft_only')}</p></div></header>
    {pending.length === 0 && <p>{t('review.empty')}</p>}
    {pending.map((suggestion, index) => {
      const current = suggestionValue(draft, suggestion);
      const conflict = !sameValue(current, suggestion.baseline);
      const trackIndex = draft.tracks.findIndex(track => track.slotId === suggestion.slotId);
      const filename = suggestion.scope === 'track' ? filenames?.find(file => file.slotId === suggestion.slotId)?.relativePath : undefined;
      const label = `${trackIndex >= 0 ? `${trackIndex + 1} · ` : ''}${t(`field.${suggestion.field}`)}`;
      return <article className={`${styles.card} ${conflict ? styles.conflict : ''}`} key={suggestion.id}>
        <div className={styles.row}><div><label className={styles.check}><input type="checkbox" aria-describedby={filename ? `${contextId}-${index}` : undefined} checked={allowed.includes(suggestion.id)} disabled={disabled || conflict}
          onChange={event => onSelect(event.target.checked ? [...allowed, suggestion.id] : allowed.filter(id => id !== suggestion.id))} />{label}</label>{filename && <p id={`${contextId}-${index}`} className={`${styles.meta} ${styles.filename}`}>{filename}</p>}</div><button className={styles.button} type="button" disabled={disabled} onClick={() => onReject([suggestion.id])}>{t('action.keep')}</button></div>
        <div className={styles.diff}>
          <div><strong>{t('review.baseline')}</strong><pre>{reviewValueText(suggestion.baseline)}</pre></div>
          <div><strong>{t('review.current')}</strong><pre>{reviewValueText(current)}</pre></div>
          <div><strong>{t('review.suggested')}</strong><pre>{reviewValueText(suggestion.value)}</pre></div>
        </div>
        <details className={styles.details}><summary>{t('layout.evidence')}</summary><p>{t('review.source', { source: t(`source.${suggestion.source}`) })} · {suggestion.evidence}</p></details>
        {conflict && <p>{t('review.conflict')}</p>}
        {sameValue(current, suggestion.value) && <p>{t('review.already_matches')}</p>}
      </article>;
    })}
    {pending.length > 0 && <div className={styles.actions}>
      <span>{t('review.selected', { count: allowed.length })}</span>
      <button className={`${styles.button} ${styles.primary}`} type="button" disabled={disabled || !allowed.length} onClick={() => onAdopt(allowed)}>{t('action.apply')}</button>
      <button className={styles.button} type="button" disabled={disabled} onClick={() => onReject(pending.map(item => item.id))}>{t('review.keep_remaining')}</button>
    </div>}
  </section>;
}
