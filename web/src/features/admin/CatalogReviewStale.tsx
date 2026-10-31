import { useEffect, useRef } from 'react';
import { useAdminText } from './AdminAccess';
import type { CatalogReview } from './catalogReviewApi';
import { reviewValueText } from './reviewValueText';
import styles from './adminStyles';

/**
 * The stale view of an Album completion whose source is no longer current (docs/features/admin-workbench.md, the stale view): that
 * this completion is out of date and cannot overwrite content saved later, why (the source changed, or is no longer ready), and the
 * old draft read-only behind a disclosure; it is never submitted again. The page keeps Discard completion beside it and the action
 * bar opens the latest Album. Its heading takes the focus when a refused update led here (`focus`).
 */
export function CatalogReviewStale({ item, focus }: { item: CatalogReview; focus: boolean }) {
  const t = useAdminText(), heading = useRef<HTMLHeadingElement>(null), { album, tracks } = item.draft;
  useEffect(() => { if (focus) heading.current?.focus(); }, [focus]);
  return <section aria-labelledby="catalog-review-stale" className={styles.panel}>
    <h2 id="catalog-review-stale" ref={heading} tabIndex={-1}>{t('catalog_review.stale_title')}</h2>
    <p>{t('catalog_review.stale_copy')}</p>
    {item.sourceStatus !== 'current' && <p>{t(`catalog_review.source_${item.sourceStatus}`)}</p>}
    <details className={styles.details}><summary>{t('catalog_review.stale_draft')}</summary>
      <dl><div><dt>{t('field.title')}</dt><dd>{album.title || '—'}</dd></div><div><dt>{t('field.releaseDate')}</dt><dd>{reviewValueText(album.releaseDate)}</dd></div></dl>
      <ol>{tracks.map(track => <li key={track.slotId}>{`${track.title || '—'} · ${[track.discNumber, track.trackNumber].map(value => value ?? '—').join('-')}`}</li>)}</ol>
    </details>
  </section>;
}
