import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { ModalDialog } from '../../components/ModalDialog';
import { useLocalization } from '../../localization/LocalizationProvider';
import type { MessageKey } from '../../localization/contract';
import { useAdminAccess, useAdminText } from './AdminAccess';
import { adminEndpointRequest } from './adminTransport';
import { catalogResponse, type CatalogCredit, type CatalogEditPatch, type CatalogItem } from './catalogApi';
import { expectedSummaryVariables, type CatalogAlbumExpectedSummary } from './catalogAlbumExpectedSummary';
import { reviewValueText } from './reviewValueText';
import styles from './adminStyles';

/** The displayed differences and eventual command share this captured item and partial patch or expected tracklist clear. */
export interface CatalogEditSnapshot {
  item: CatalogItem;
  patch: CatalogEditPatch;
  /** The tracklist a clear removes, as the Tracks section last read it. */
  expected?: CatalogAlbumExpectedSummary;
}

/** Resolves only a credit's display name; its identity, role and position remain frozen in the patch. */
function CreditValue({ credit }: { credit: CatalogCredit }) {
  const t = useAdminText(), access = useAdminAccess(), { t: sharedText } = useLocalization();
  const [recordOpen, setRecordOpen] = useState(false);
  const name = useQuery({
    queryKey: ['admin-imports', access.viewerId, access.epoch, access.generation, 'credit', credit.subjectType, credit.subjectId],
    queryFn: ({ signal }) => adminEndpointRequest(`/catalog/${credit.subjectType}/${credit.subjectId}`,
      catalogResponse.refine(value => value.item.kind === credit.subjectType && value.item.id === credit.subjectId), { signal }),
    retry: false, gcTime: 0
  });
  const label = name.data && 'name' in name.data.item.fields ? name.data.item.fields.name
    : t(name.isError ? 'catalog.credit_unavailable' : 'common.loading', { id: credit.subjectId });
  const role = credit.role === 'legacyUnspecified' ? t('catalog.unspecified')
    : sharedText(`catalog.credit.${credit.role}` as MessageKey);
  return <li>{label} · {t(`catalog.${credit.subjectType}`)} · {role}{credit.joinPhrase !== undefined && <> · {t('catalog.join_phrase_value', { phrase: credit.joinPhrase })}</>}
    {/* The modal trap sees the summary, while closed records contribute no hidden focus targets. */}
    <details onToggle={event => setRecordOpen(event.currentTarget.open)}><summary tabIndex={0}>{t('catalog.credit_record')}</summary>
      {recordOpen && <Link className={`${styles.itemLink} ${styles.rawDraft}`} to={`/admin/catalog/${credit.subjectType}/${credit.subjectId}`}>{credit.subjectId}</Link>}
    </details>
  </li>;
}

/** Dates keep their precision, enums use human labels, and unavailable Credits stay distinct from an empty list. */
function FieldValue({ field, value }: { field: string; value: unknown }) {
  const t = useAdminText();
  if (field === 'credits') {
    if (value === null) return <pre>{t('catalog.credits_unavailable')}</pre>;
    const credits = value as CatalogCredit[];
    return credits.length ? <ol className={styles.rawDraft}>{credits.map(credit => <CreditValue key={credit.creditId} credit={credit} />)}</ol>
      : <pre>{t('catalog.no_credits')}</pre>;
  }
  const label = field === 'visibility' ? t(`field.${value}`)
    : field === 'attributionStatus' ? t(`catalog.${value}`)
    : field === 'organizationType' ? t(`organization.${value}`) : reviewValueText(value);
  return <pre>{label}</pre>;
}

/** A stale confirmation keeps the original differences visible and directs the admin back to review. */
export function CatalogEditConfirmation({ snapshot, stale, disabled, onClose, onConfirm }: {
  snapshot: CatalogEditSnapshot; stale: boolean; disabled: boolean; onClose: () => void; onConfirm: () => void;
}) {
  const t = useAdminText(), initialFocus = useRef<HTMLElement>(null), { locale } = useLocalization();
  const { item, patch, expected } = snapshot;
  const previous = item.fields as Record<string, unknown>;
  // A clear changes no field: it shows the stored tracklist against none instead.
  const clearing = 'clearExpectedTracklist' in patch;
  const changes = clearing ? [] : [...Object.entries(patch.fields ?? {}), ...(patch.visibility ? [['visibility', patch.visibility] as const] : [])];
  return <ModalDialog title={t('catalog.confirm')} description={t('catalog.confirm_copy')}
    headerContent={<div className={styles.target}><strong>{('name' in item.fields ? item.fields.name : item.fields.title) || t('common.untitled')}</strong></div>}
    initialFocusRef={initialFocus} onClose={onClose}>
    {stale && <p role="alert" className={styles.error}>{t('catalog.confirm_stale')}</p>}
    {clearing && <article className={styles.card}>
      <h3>{t('catalog.album_expected')}</h3>
      <div className={styles.diff}>
        <div><strong>{t('catalog.current_value')}</strong><pre>{expected ? t('catalog.album_expected_summary', expectedSummaryVariables(expected, locale)) : t('catalog.album_expected')}</pre></div>
        <div><strong>{t('catalog_review.saved_value')}</strong><pre>{t('catalog.album_expected_none')}</pre></div>
      </div>
      <p className={styles.muted}>{t('catalog.album_expected_clear_copy')}</p>
    </article>}
    {changes.map(([field, value]) => <article className={styles.card} key={field}>
      <h3>{t(field === 'credits' ? 'catalog.credits' : field === 'attributionStatus' ? 'catalog.attribution' : `field.${field}`)}</h3>
      <div className={styles.diff}>
        <div><strong>{t('catalog.current_value')}</strong><FieldValue field={field} value={field === 'visibility' ? item.visibility : previous[field]} /></div>
        <div><strong>{t('catalog_review.saved_value')}</strong><FieldValue field={field} value={value} /></div>
      </div>
    </article>)}
    <div className={styles.dialogActions}><button className={styles.button} type="button" onClick={onClose}>{t('common.cancel')}</button>
      <button className={`${styles.button} ${styles.primary}`} type="button" disabled={disabled || stale || (!clearing && !changes.length)} onClick={onConfirm}>{t(clearing ? 'catalog.album_expected_clear' : 'catalog.save')}</button></div>
  </ModalDialog>;
}
