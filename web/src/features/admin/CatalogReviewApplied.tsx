import { useEffect, useId, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocalization } from '../../localization/LocalizationProvider';
import { useAdminAccess, useAdminText } from './AdminAccess';
import type { CatalogReview, ReviewField } from './catalogReviewApi';
import { LunaStatus } from './catalogReviewBrief';
import { CatalogReviewCompactRows } from './CatalogReviewCompactRows';
import { catalogReviewSummaryQuery } from './catalogReviewSummaryQuery';
import styles from './adminStyles';

/**
 * An applied Album completion's outcome view, read-only (docs/features/admin-workbench.md, the applied view; its own chunk): Luna
 * AI's status once Luna AI was used, that the original Album was updated, how many fields the apply wrote with one compact row per
 * affected Track and per Album value (each said updated), when the original Album was updated (in the interface language), the
 * fields the apply wrote behind a disclosure (a track's named by its title, as the update range named it) and, for a completion
 * captured for lookup, the release its metadata lookup applied (from its lookup read, read once, never polled) and how the edition
 * stands: matched where lookup preselected the release on a match with nothing left unchecked, else unconfirmed, naming a release
 * the administrator chose. Nothing can be selected or applied; the action bar opens the original Album. The review detail does not
 * list the members whose track Artists an apply wrote, so such a completion says they are not listed, or, when the apply wrote only
 * those, says so. Its heading takes the focus when this page's update led here (`focus`).
 */
export function CatalogReviewApplied({ item, focus = false }: { item: CatalogReview; focus?: boolean }) {
  const t = useAdminText(), access = useAdminAccess(), { locale } = useLocalization(), id = useId(), heading = useRef<HTMLHeadingElement>(null);
  const captured = item.draft.album.expectedTracklist !== undefined;
  const read = useQuery({ ...catalogReviewSummaryQuery(access, item, true), refetchInterval: false, enabled: captured });
  const lookup = read.data?.lookup, used = lookup?.applied && lookup.applied.choice !== 'none' ? lookup.applied : null;
  const release = used ? lookup!.candidates.find(candidate => candidate.key === used.candidateKey)?.title : null;
  const fields = item.applied?.fields ?? [];
  useEffect(() => { if (focus) heading.current?.focus(); }, [focus]);
  // A track by its title, as the update range named it (its position may be what the apply changed); by position only untitled.
  const label = (value: ReviewField) => {
    const field = t(`field.${value.field}`), index = item.draft.tracks.findIndex(track => track.slotId === value.slotId), title = item.draft.tracks[index]?.title;
    return value.scope === 'album' ? field : title ? t('catalog_review.applied_track_field', { title, field }) : t('summary.track_field', { position: index + 1, field });
  };
  // Matched only where lookup preselected the release it used on a match and left nothing unchecked.
  const matched = used?.choice === 'preselected' && used.basis !== null && used.basis !== 'chosen' && !used.notChecked;
  const edition = matched && release ? t('catalog_review.applied_edition_matched', { title: release })
    : used?.choice === 'chosen' && release ? t('catalog_review.applied_edition_chosen', { title: release }) : t('catalog_review.applied_edition_unconfirmed');
  return <section aria-labelledby={`${id}-title`} className={styles.panel}>
    {item.analysis.generation > 0 && <LunaStatus item={item} />}
    <p className={styles.meta}>{t('catalog_review.applied')}</p>
    <h2 id={`${id}-title`} ref={heading} tabIndex={-1}>{t('catalog_review.applied_count', { count: fields.length })}</h2>
    {fields.length > 0 && <CatalogReviewCompactRows item={item} fields={fields} members={[]} done />}
    {item.applied && <p>{t('catalog_review.applied_when', { date: new Date(item.applied.at).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' }) })}</p>}
    {fields.length ? <details className={styles.details}><summary>{t('catalog_review.applied_title')}</summary>
      <ul>{fields.map(value => <li key={`${value.scope}:${value.slotId ?? ''}:${value.field}`}>{label(value)}</li>)}</ul></details>
      : <p>{t('catalog_review.applied_members_only')}</p>}
    {captured && fields.length > 0 && <p className={styles.muted}>{t('catalog_review.applied_members_note')}</p>}
    {release && <p className={styles.muted}>{t('catalog_review.applied_release', { title: release, source: used!.source === 'itunes' ? 'iTunes' : 'MusicBrainz' })}</p>}
    {(!captured || read.data) && <p><strong>{edition}</strong></p>}
    <p className={styles.muted}>{t('catalog_review.applied_copy')}</p>
  </section>;
}
