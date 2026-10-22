import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { ModalDialog } from '../../components/ModalDialog';
import { useAdminAccess, useAdminText } from './AdminAccess';
import { adminWorkspace } from './adminWorkspace';
import { AdminCommand } from './useAdminCommand';
import { useOnline } from './useAdminOnline';
import styles from './adminStyles';

const id = z.string().regex(/^[a-f0-9]{24}$/);
/** POST /catalog-reviews/:id/discard (CatalogReviewDiscardResponse on the server). */
const discardSchema = z.object({ discarded: z.object({ id, albumId: id }).strict(),
  receipt: z.object({ operationId: z.string().uuid(), kind: z.literal('discard'), revision: z.number().int().nonnegative() }).strict() }).strict();
type Discarded = z.infer<typeof discardSchema>;
/** This command's own refusals, shown as `catalog_review.<name>`: Luna AI queued or running, and an applied review. */
const refusals = { ADMIN_IMPORT_ANALYSIS_ACTIVE: 'discard_luna', ADMIN_CATALOG_REVIEW_APPLIED: 'discard_applied' } as const;
/** Stands in for a review without a buffered command of its own: nothing of it runs. */
const idleState = { running: false, intent: null }, idle = { subscribe: () => () => {}, getSnapshot: () => idleState };

/**
 * Discard completion for an unapplied Album completion (owner rules: docs/business-rules.md, Catalog Visibility and
 * Administration). Never primary: it opens a confirmation that names the catalog Album (the draft title only as secondary text when
 * it differs), says what is lost and that the catalog does not change, and focuses Cancel. Confirming sends the revision the
 * confirmation showed, and the server decides whether a later administrator change makes it stale. The command is buffered per
 * review, so an unknown outcome is retried only with its original intent. Once the review is discarded, by this command or
 * elsewhere (a refusal as `discarded`), it forgets the review's buffers, calls `onDiscarded` (the caller navigates), drops the
 * review's reads and reads the rest of the queue and eligibility again; a refusal (stale, Luna AI active, applied) reads them
 * again too. `reason` names why it is `disabled`. The review page's own change (its buffered save, Luna AI or apply command)
 * also disables it while running or unconfirmed, on the page and on the queue card alike.
 */
export function CatalogReviewDiscard({ id: reviewId, albumId, albumTitle, draftTitle, expectedRevision, disabled, reason, onDiscarded }: {
  id: string; albumId: string; albumTitle: string; draftTitle: string; expectedRevision: number; disabled: boolean; reason: string | null; onDiscarded?: () => void;
}) {
  const t = useAdminText(), access = useAdminAccess(), online = useOnline(), client = useQueryClient(), uid = useId();
  const cancel = useRef<HTMLButtonElement>(null);
  // The revision the open confirmation showed: confirming binds it, never a newer one read meanwhile.
  const [shown, setShown] = useState<number | null>(null);
  const [command] = useState(() => {
    const key = `catalog-review-discard:${reviewId}`, found = adminWorkspace.buffer<AdminCommand<Discarded>>(key);
    if (found) return found;
    const value = new AdminCommand(discardSchema.refine(item => item.discarded.id === reviewId && item.discarded.albumId === albumId), undefined, refusals);
    adminWorkspace.retain(key, value, adminWorkspace.capture());
    return value;
  });
  const state = useSyncExternalStore(command.subscribe, command.getSnapshot, command.getSnapshot);
  const done = Boolean(state.result) || state.error === 'discarded';
  useEffect(() => {
    if (!done) return;
    for (const name of ['catalog-review-editor', 'catalog-review-stage', 'catalog-review-command', 'catalog-review-discard']) adminWorkspace.forget(`${name}:${reviewId}`);
    onDiscarded?.();
    // The prefix covers the review's detail, lookup summary and identity rows, so nothing reads the discarded review again.
    const review = ['admin-catalog-reviews', access.viewerId, access.epoch, access.generation, reviewId];
    void client.cancelQueries({ queryKey: review }); client.removeQueries({ queryKey: review });
    void client.invalidateQueries({ queryKey: ['admin-catalog-reviews'] });
  }, [done]);
  useEffect(() => {
    if (state.error === 'conflict' || state.error === 'discard_luna' || state.error === 'discard_applied') void client.invalidateQueries({ queryKey: ['admin-catalog-reviews'] });
  }, [state.error]);
  const found = adminWorkspace.buffer(`catalog-review-command:${reviewId}`), own = found instanceof AdminCommand ? found : idle;
  const page = useSyncExternalStore<{ running: boolean; intent: unknown }>(own.subscribe, own.getSnapshot, own.getSnapshot);
  const locked = disabled || !online || state.running || Boolean(state.intent) || page.running || Boolean(page.intent);
  return <>
    <div className={styles.actions}><button className={styles.button} type="button" disabled={locked}
      aria-describedby={disabled && reason ? `${uid}-reason` : undefined} onClick={() => setShown(expectedRevision)}>{t('catalog_review.discard')}</button></div>
    {disabled && reason && <p id={`${uid}-reason`} className={styles.muted}>{t(reason)}</p>}
    {state.error && <div role="alert" className={styles.error}><p>{t(state.error.startsWith('discard_') ? `catalog_review.${state.error}` : `common.${state.error}`)}</p>
      {state.intent && <button className={styles.button} type="button" disabled={state.running || !online} onClick={command.retry}>{t('common.retry_operation')}</button>}</div>}
    {shown !== null && <ModalDialog title={t('catalog_review.discard_title')} description={t('catalog_review.discard_copy')}
      headerContent={<div className={styles.target}><strong>{albumTitle || t('common.untitled')}</strong>
        {draftTitle && draftTitle !== albumTitle && <p className={styles.muted}>{draftTitle}</p>}</div>}
      initialFocusRef={cancel} onClose={() => setShown(null)}>
      <div className={styles.dialogActions}><button ref={cancel} className={styles.button} type="button" onClick={() => setShown(null)}>{t('common.cancel')}</button>
        <button className={styles.button} type="button" disabled={locked} onClick={() => {
          const revision = shown;
          setShown(null);
          command.run(`/catalog-reviews/${reviewId}/discard`, { expectedRevision: revision }, 'POST');
        }}>{t('catalog_review.discard_confirm')}</button></div>
    </ModalDialog>}
  </>;
}
