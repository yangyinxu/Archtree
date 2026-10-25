import { useId } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocalization } from '../../localization/LocalizationProvider';
import { useAdminAccess, useAdminText } from './AdminAccess';
import type { CatalogReview, ReviewField } from './catalogReviewApi';
import { catalogReviewSummaryQuery } from './catalogReviewSummaryQuery';
import styles from './adminStyles';

/**
 * An applied Album completion's Update original Album step, read-only: when the original Album was updated (in the interface
 * language), the fields the apply wrote and, for a completion captured for lookup, the release its metadata lookup applied (from
 * its lookup read, read once, never polled). Nothing can be selected or applied. The review detail does not list the members
 * whose track Artists an apply wrote, so such a completion says they are not listed, or, when the apply wrote only those, says so.
 */
export function CatalogReviewApplied({ item }: { item: CatalogReview }) {
  const t = useAdminText(), access = useAdminAccess(), { locale } = useLocalization(), id = useId();
  const captured = item.draft.album.expectedTracklist !== undefined;
  const read = useQuery({ ...catalogReviewSummaryQuery(access, item, true), refetchInterval: false, enabled: captured });
  const lookup = read.data?.lookup, used = lookup?.applied && lookup.applied.choice !== 'none' ? lookup.applied : null;
  const release = used ? lookup!.candidates.find(candidate => candidate.key === used.candidateKey)?.title : null;
  const fields = item.applied?.fields ?? [];
  const label = (value: ReviewField) => value.scope === 'album' ? t(`field.${value.field}`)
    : t('summary.track_field', { position: item.draft.tracks.findIndex(track => track.slotId === value.slotId) + 1, field: t(`field.${value.field}`) });
  return <section aria-labelledby={`${id}-title`} className={styles.panel}><h2 id={`${id}-title`}>{t('catalog_review.applied_title')}</h2>
    {item.applied && <p>{t('catalog_review.applied_when', { date: new Date(item.applied.at).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' }) })}</p>}
    {fields.length ? <ul>{fields.map(value => <li key={`${value.scope}:${value.slotId ?? ''}:${value.field}`}>{label(value)}</li>)}</ul>
      : <p>{t('catalog_review.applied_members_only')}</p>}
    {captured && fields.length > 0 && <p className={styles.muted}>{t('catalog_review.applied_members_note')}</p>}
    {release && <p className={styles.muted}>{t('catalog_review.applied_release', { title: release, source: used!.source === 'itunes' ? 'iTunes' : 'MusicBrainz' })}</p>}
  </section>;
}
