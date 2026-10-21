import { useId } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAdminAccess, useAdminText } from './AdminAccess';
import { reviewFieldKey, type CatalogReview, type ReviewChange, type ReviewField } from './catalogReviewApi';
import type { ReviewLookupResponse } from './catalogReviewLookupApi';
import { pairingFilledNumbers } from './catalogReviewSummaryModel';
import { catalogReviewKey } from './catalogReviewSummaryQuery';
import { reviewValueText } from './reviewValueText';
import styles from './adminStyles';

/** Original catalog values remain distinct from manually edited or adopted review draft values. */
function CatalogReviewChangeValues({ change }: { change: ReviewChange }) {
  const t = useAdminText();
  return <div className={styles.diff}><div><strong>{t('catalog_review.original_value')}</strong><pre>{reviewValueText(change.baseline)}</pre></div>
    <div><strong>{t('catalog_review.saved_value')}</strong><pre>{reviewValueText(change.value)}</pre></div></div>;
}

/** A confirmation renders the selected frozen values, never a refreshed live project. */
export function CatalogReviewChangeSummary({ change }: { change: ReviewChange }) {
  const t = useAdminText();
  return <article className={styles.card}><h3>{t('catalog_review.select_field', {
    type: t(`catalog_review.target_${change.scope}`),
    target: change.title || t('common.untitled'), field: t(`field.${change.field}`)
  })}</h3><CatalogReviewChangeValues change={change} /></article>;
}

/**
 * Only saved differences can be selected; the parent freezes the final catalog confirmation. A Disc or Track Number that metadata
 * lookup filled through its pairing (read from the lookup summary's cached read of this revision) applies only together with the
 * expected tracklist, which this selection does not send: it is shown, never selectable, and never confirmed.
 */
export function CatalogReviewApply({ item, changes, selected, disabled, onSelect, onConfirm }: {
  item: CatalogReview; changes: ReviewChange[]; selected: ReviewChange[]; disabled: boolean;
  onSelect: (key: string, checked: boolean) => void; onConfirm: (fields: ReviewField[]) => void;
}) {
  const t = useAdminText(), access = useAdminAccess(), id = useId();
  const read = useQuery<ReviewLookupResponse>({ queryKey: [...catalogReviewKey(access, item.id), 'lookup', item.revision], enabled: false, gcTime: 0 }).data;
  const filled = pairingFilledNumbers(read?.lookup, item.draft), held = (change: ReviewChange) => filled.has(`tracks.${change.slotId}.${change.field}`);
  const chosen = selected.filter(change => !held(change));
  return <section className={styles.panel}><h2>{t('catalog_review.apply_title')}</h2><p className={styles.muted}>{t('catalog_review.apply_copy')}</p>
    {!changes.length && <p>{t('catalog_review.no_changes')}</p>}
    {changes.map(change => { const key = reviewFieldKey(change), waits = held(change); return <article className={styles.card} key={key}>
      <label className={styles.check}><input type="checkbox" checked={chosen.some(value => reviewFieldKey(value) === key)} aria-describedby={waits ? `${id}-${key}` : undefined}
        disabled={disabled || !item.capabilities.apply || waits} onChange={event => onSelect(key, event.target.checked)} />
        {t('catalog_review.select_field', { type: t(`catalog_review.target_${change.scope}`), target: change.title || t('common.untitled'), field: t(`field.${change.field}`) })}</label>
      {waits && <p id={`${id}-${key}`} className={styles.muted}>{t('catalog_review.number_with_tracklist')}</p>}
      <CatalogReviewChangeValues change={change} />
    </article>; })}
    <div className={styles.actions}><span>{t('catalog_review.selected', { count: chosen.length })}</span>
      <button className={`${styles.button} ${styles.primary}`} type="button" disabled={disabled || !item.capabilities.apply || !chosen.length}
        onClick={() => onConfirm(chosen.map(({ scope, slotId, field }) => ({ scope, slotId, field })))}>{t('catalog_review.apply_action', { count: chosen.length })}</button></div>
    {item.state === 'reviewing' && item.sourceStatus === 'current' && !item.capabilities.apply && <p>{t('catalog_review.unavailable')}</p>}
  </section>;
}
