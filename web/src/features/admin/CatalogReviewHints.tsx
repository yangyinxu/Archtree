import type { ImportArtistEntry, ImportDraftV2, ImportSuggestionV2 } from './adminNamingSchema';
import { useAdminText } from './AdminAccess';
import { entriesByline } from './artistEntriesByline';
import { reviewValueText } from './reviewValueText';
import styles from './adminStyles';

/** Artist entries read as their byline and a label as its name; no value reads as the shared empty text. */
const hintText = (value: unknown) => Array.isArray(value) && value.length ? entriesByline(value as ImportArtistEntry[])
  : value && typeof value === 'object' && 'name' in value ? String(value.name) : reviewValueText(null);

/**
 * Luna's Artist-entries and label suggestions in an existing-Album review: identity hints for the original Album's Credits, which
 * only a separate catalog Credit edit changes. Each shows its baseline, the current value and the suggestion, and can only be
 * kept (Keep current rejects it): the server refuses adopting one, so a review never changes Credits. Loaded with Review.
 */
export function CatalogReviewHints({ suggestions, album, disabled, onKeep }: {
  suggestions: ImportSuggestionV2[]; album: Pick<ImportDraftV2['album'], 'artists' | 'label'>; disabled: boolean; onKeep: (id: string) => void;
}) {
  const t = useAdminText();
  return <section className={styles.panel}><h2>{t('catalog_review.hints_title')}</h2><p>{t('catalog_review.artist_hint')}</p>
    {suggestions.map(value => <article key={value.id} className={styles.card}>
      <p className={styles.meta}>{t(value.field === 'label' ? 'field.label' : 'field.artists')}</p>
      <div className={styles.diff}><div><strong>{t('review.baseline')}</strong><pre>{hintText(value.baseline)}</pre></div>
        <div><strong>{t('review.current')}</strong><pre>{hintText(value.field === 'label' ? album.label : album.artists)}</pre></div>
        <div><strong>{t('review.suggested')}</strong><pre>{hintText(value.value)}</pre></div></div>
      {value.decision === 'pending' && <button className={styles.button} type="button" disabled={disabled} onClick={() => onKeep(value.id)}>{t('action.keep')}</button>}
    </article>)}
  </section>;
}
