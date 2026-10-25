import { useEffect, useId, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { z } from 'zod';
import { ModalDialog } from '../../components/ModalDialog';
import { useAdminAccess, useAdminText } from './AdminAccess';
import { adminEndpointRequest } from './adminTransport';
import type { CatalogItem } from './catalogApi';
import { lookupBriefMessage, lookupBriefSchema } from './lookupBrief';
import { useCatalogReviewCommand } from './useCatalogReviewCommand';
import { useOnline } from './useAdminOnline';
import styles from './adminStyles';

/**
 * GET /catalog-reviews/eligibility (CatalogReviewEligibility on the server): a reason exactly when a review cannot be created, and
 * the open review's lookup brief, absent from a server before lookup briefs.
 */
const eligibilitySchema = z.object({ eligible: z.boolean(),
  reason: z.enum(['albumNotReady', 'tooManyTracks', 'membershipInvalid', 'membershipInconsistent', 'videoTracks', 'tracksNotReady', 'valuesUnsupported']).nullable(),
  openReviewId: z.string().regex(/^[a-f0-9]{24}$/).nullable(), lookupAvailable: z.boolean(), openLookup: lookupBriefSchema.nullable().optional() }).strict()
  .refine(value => value.eligible === (value.reason === null));

/**
 * The Album page's entry to an Album completion (owner rules: docs/business-rules.md, Catalog Visibility and Administration):
 * Complete from MusicBrainz (free) creates a private existing-Album review whose free metadata lookup the server starts, never
 * Luna AI, or one for manual editing where lookup is not configured. It reads the Album's eligibility for its current revision:
 * disabled while that read loads, with a retry when it fails, and with the reason for an Album that cannot have a review. While an
 * unapplied review whose source is current exists, it opens that review and creating another is an explicit choice. While
 * catalog editing is off it still opens that review, and creating stays disabled. Creating is a separate confirmation of the
 * frozen Album; a refused creation reads the eligibility again. It renders into the page hero's completion block, which gives
 * each note its own row: the open-completion note above the buttons, which says what its lookup found when the server sends that
 * (read again while that lookup is active, for a bounded time), and the reasons below them, which describe the buttons. `note` is
 * the page's own reason, such as unsaved edits.
 */
export function CatalogReviewStart({ item, disabled = false, note }: { item: CatalogItem; disabled?: boolean; note?: string }) {
  const t = useAdminText(), access = useAdminAccess(), online = useOnline(), navigate = useNavigate(), id = useId();
  const [target, setTarget] = useState<{ item: CatalogItem; another: boolean } | null>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const mutation = useCatalogReviewCommand(`create:${item.id}`, { albumId: item.id });
  const locked = disabled || mutation.running || Boolean(mutation.intent) || !online;
  const canCreate = item.capabilities.editing && access.catalogEditing;
  const query = useQuery({
    queryKey: ['admin-catalog-reviews', access.viewerId, access.epoch, access.generation, 'eligibility', item.id, item.revision],
    queryFn: ({ signal }) => adminEndpointRequest(`/catalog-reviews/eligibility?albumId=${item.id}`, eligibilitySchema, { signal }),
    enabled: item.kind === 'album', retry: false, gcTime: 0,
    // The open completion's note follows its active lookup: every 5 seconds, for at most 180 reads (15 minutes), and never offline.
    refetchInterval: query => online && ['queued', 'running', 'retrying'].includes(query.state.data?.openLookup?.state ?? '') && query.state.dataUpdateCount < 180 ? 5000 : false
  });
  useEffect(() => {
    if (!mutation.result) return;
    const id = mutation.result.item.id;
    mutation.command.acknowledge();
    navigate(`/admin/catalog-reviews/${id}`);
  }, [mutation.result, navigate]);
  // A creation refused because a review opened meanwhile (or anything else changed), or because a retried creation's review was
  // discarded meanwhile, shows what the Album offers now.
  useEffect(() => { if (mutation.error === 'conflict' || mutation.error === 'discarded') void query.refetch(); }, [mutation.error]);
  if (item.kind !== 'album') return null;
  const state = query.data, lookup = state?.lookupAvailable ?? true, open = state?.openLookup ? lookupBriefMessage(state.openLookup, 'open_lookup') : null;
  // Every reason shown under the buttons describes them, so a disabled button is announced with why.
  const reasons = [note && `${id}-note`, !canCreate && `${id}-unavailable`, state?.reason && `${id}-reason`].filter(Boolean).join(' ') || undefined;
  const label = t(lookup ? 'catalog_review.create' : 'catalog_review.create_manual');
  const blocked = (value: CatalogItem) => locked || !canCreate || value.revision !== item.revision;
  return <>
    {state?.openReviewId ? <><p className={styles.muted}>{open ? t(open.key, open.values) : t('catalog_review.open_copy')}</p>
      <Link className={`${styles.link} ${styles.primary}`} to={`/admin/catalog-reviews/${state.openReviewId}`}>{t('workbench.open_review')}</Link>
      <button className={styles.button} type="button" disabled={locked || !canCreate || !state.eligible} aria-describedby={reasons}
        onClick={() => setTarget({ item, another: true })}>{t('catalog_review.create_another')}</button></>
      : <button className={`${styles.button} ${styles.primary}`} type="button" disabled={locked || !canCreate || !state?.eligible} aria-describedby={reasons}
        onClick={() => setTarget({ item, another: false })}>{label}</button>}
    {note && <p id={`${id}-note`} className={styles.muted}>{note}</p>}
    {!canCreate && <p id={`${id}-unavailable`} className={styles.muted}>{t('catalog_review.unavailable')}</p>}
    {state?.reason && <p id={`${id}-reason`} className={styles.muted}>{t(`catalog_review.ineligible_${state.reason}`)}</p>}
    {query.isError && <div role="alert" className={styles.error}><p>{t('common.error')}</p>
      <button className={styles.button} type="button" disabled={query.isFetching || !online} onClick={() => void query.refetch()}>{t('common.retry')}</button></div>}
    {mutation.error && <div role="alert" className={styles.error}><p>{t(`common.${mutation.error}`)}</p>
      {mutation.intent && <button className={styles.button} type="button" disabled={mutation.running || !online} onClick={mutation.command.retry}>{t('common.retry_operation')}</button>}
    </div>}
    {target?.item.kind === 'album' && <ModalDialog title={target.another ? t('catalog_review.create_another') : label}
      description={[target.another ? t('catalog_review.open_copy') : '', t(lookup ? 'catalog_review.create_copy' : 'catalog_review.create_manual_copy')].filter(Boolean).join(' ')}
      headerContent={<div className={styles.target}><strong>{target.item.fields.title || t('common.untitled')}</strong></div>}
      initialFocusRef={cancel} onClose={() => setTarget(null)}>
      <div className={styles.dialogActions}><button className={styles.button} ref={cancel} type="button" onClick={() => setTarget(null)}>{t('common.cancel')}</button>
        <button className={`${styles.button} ${styles.primary}`} type="button" disabled={blocked(target.item)}
          onClick={() => {
            if (blocked(target.item)) return;
            setTarget(null);
            mutation.command.run('/catalog-reviews', { albumId: target.item.id, expectedRevision: target.item.revision, ...(target.another ? { another: true } : {}) }, 'POST');
          }}>{t(lookup ? 'catalog_review.create' : 'catalog_review.create_confirm')}</button></div>
    </ModalDialog>}
  </>;
}
