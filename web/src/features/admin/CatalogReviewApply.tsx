import { useAdminText } from './AdminAccess';
import { reviewFieldKey, type CatalogReview, type ReviewChange, type ReviewField } from './catalogReviewApi';
import { reviewValueText } from './reviewValueText';
import styles from './adminStyles';

/** Only saved differences can be selected; the parent freezes the final catalog confirmation. */
export function CatalogReviewApply({ item, changes, selected, disabled, onSelect, onConfirm }: {
  item: CatalogReview; changes: ReviewChange[]; selected: ReviewChange[]; disabled: boolean;
  onSelect: (key: string, checked: boolean) => void; onConfirm: (fields: ReviewField[]) => void;
}) {
  const t = useAdminText();
  return <section className={styles.panel}><h2>{t('catalog_review.apply_title')}</h2><p className={styles.muted}>{t('catalog_review.apply_copy')}</p>
    {!changes.length && <p>{t('catalog_review.no_changes')}</p>}
    {changes.map(change => <article className={styles.card} key={reviewFieldKey(change)}>
      <label className={styles.check}><input type="checkbox" checked={selected.some(value => reviewFieldKey(value) === reviewFieldKey(change))}
        disabled={disabled || !item.capabilities.apply} onChange={event => onSelect(reviewFieldKey(change), event.target.checked)} />
        {t('catalog_review.select_field', { target: change.title || t('common.untitled'), field: t(`field.${change.field}`) })}</label>
      <div className={styles.diff}><div><strong>{t('review.baseline')}</strong><pre>{reviewValueText(change.baseline)}</pre></div>
        <div><strong>{t('catalog_review.saved_value')}</strong><pre>{reviewValueText(change.value)}</pre></div></div>
    </article>)}
    <div className={styles.actions}><span>{t('catalog_review.selected', { count: selected.length })}</span>
      <button className={`${styles.button} ${styles.primary}`} type="button" disabled={disabled || !item.capabilities.apply || !selected.length}
        onClick={() => onConfirm(selected.map(({ scope, slotId, field }) => ({ scope, slotId, field })))}>{t('catalog_review.apply_action')}</button></div>
    {item.state === 'reviewing' && item.sourceStatus === 'current' && !item.capabilities.apply && <p>{t('catalog_review.unavailable')}</p>}
  </section>;
}
