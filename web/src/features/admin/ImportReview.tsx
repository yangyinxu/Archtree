import { useId, type ReactNode } from 'react';
import { useLocalization } from '../../localization/LocalizationProvider';
import type { MessageKey } from '../../localization/contract';
import type { ImportArtistEntry, ImportDetail, ImportDraft, ImportDraftV2, ImportSuggestion, ImportSuggestionV2 } from './adminApi';
import { useAdminText } from './AdminAccess';
import styles from './adminStyles';
import { entriesByline } from './importDraftPatch';
import { reviewValueText } from './reviewValueText';

export { reviewValueText } from './reviewValueText';

type ReviewDraft = ImportDraft | ImportDraftV2;
type ReviewSuggestion = ImportSuggestion | ImportSuggestionV2;
export const suggestionValue = (draft: ReviewDraft, suggestion: ReviewSuggestion): unknown => suggestion.scope === 'album'
  ? (draft.album as Record<string, unknown>)[suggestion.field]
  : draft.tracks.find(track => track.slotId === suggestion.slotId)?.[suggestion.field as 'title' | 'trackNumber'];
export const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/**
 * Artist entries read as their byline, then one numbered line per entry with its role, so a role change alone stays visible;
 * a label reads as its name and other values as the shared review text.
 */
const importValueText = (value: unknown, role: (role: string) => string) => {
  if (!Array.isArray(value)) return value && typeof value === 'object' && 'name' in value ? String(value.name) : reviewValueText(value);
  const entries = value as ImportArtistEntry[];
  return entries.length ? [entriesByline(entries), ...entries.map((entry, index) => `${index + 1}. ${entry.name} · ${role(entry.role)}`)].join('\n') : reviewValueText(null);
};

/** A changed baseline cannot be force-adopted; the administrator can edit or reject it explicitly. */
export function ImportReview({ draft, suggestions, selected, onSelect, onAdopt, onReject, disabled, filenames, emptyContent, draftCopy }: {
  draft: ReviewDraft; suggestions: ReviewSuggestion[]; selected: string[]; onSelect: (ids: string[]) => void;
  onAdopt: (ids: string[]) => void; onReject: (ids: string[]) => void; disabled: boolean; filenames?: ImportDetail['manifest']['files'];
  // The owning workflow knows whether an empty list means idle, running or handled.
  emptyContent?: ReactNode; draftCopy?: string;
}) {
  const t = useAdminText(), { t: shared } = useLocalization();
  const role = (value: string) => shared(`catalog.credit.${value}` as MessageKey);
  const contextId = useId();
  const pending = suggestions.filter(item => item.decision === 'pending');
  const eligible = pending.filter(item => sameValue(suggestionValue(draft, item), item.baseline));
  const allowed = selected.filter(id => eligible.some(item => item.id === id));
  return <section className={styles.panel}>
    <header className={styles.sectionHeader}><div><h2>{t('review.title')}</h2><p className={styles.muted}>{draftCopy ?? t('review.draft_only')}</p></div></header>
    {pending.length === 0 && (emptyContent ?? <p>{t('review.empty')}</p>)}
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
          <div><strong>{t('review.baseline')}</strong><pre>{importValueText(suggestion.baseline, role)}</pre></div>
          <div><strong>{t('review.current')}</strong><pre>{importValueText(current, role)}</pre></div>
          <div><strong>{t('review.suggested')}</strong><pre>{importValueText(suggestion.value, role)}</pre></div>
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
