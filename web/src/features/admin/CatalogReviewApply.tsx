import { Fragment, lazy, Suspense, useEffect, useId, type ComponentProps, type ComponentType } from 'react';
import { useAdminText } from './AdminAccess';
import type { CatalogReview } from './catalogReviewApi';
import type { ApplyChoice, ApplyItem, ReviewApplySelection } from './catalogReviewApplyModel';
import type * as Items from './CatalogReviewApplyItems';
import { useReviewApplyModel } from './useReviewApplyModel';
import styles from './adminStyles';

/** Stands in for the value views when their chunk cannot load (a deploy replaced it); the choices beside them stay readable. */
function ItemsUnavailable() { const t = useAdminText(); return <p role="alert">{t('common.reload')}</p>; }
/** The read-only views this step shares with its confirmation, loaded as their own chunk so this step's chunk stays within budget. */
const view = <P extends object>(pick: (module: typeof Items) => ComponentType<P>) =>
  lazy<ComponentType<P>>(() => import('./CatalogReviewApplyItems').then(module => ({ default: pick(module) }), () => ({ default: ItemsUnavailable })));
const ApplyItemValues = view<ComponentProps<typeof Items.ApplyItemValues>>(module => module.ApplyItemValues);
const ApplyIdentityLines = view<ComponentProps<typeof Items.ApplyIdentityLines>>(module => module.ApplyIdentityLines);
const ApplyAlbumNote = view<ComponentProps<typeof Items.ApplyAlbumNote>>(module => module.ApplyAlbumNote);

/**
 * The Update original Album step of an existing-Album review (owner rules: docs/business-rules.md, Catalog Visibility and
 * Administration, applying an existing-Album review): every change an apply can write (catalogReviewApplyModel.ts), each with its
 * saved and new value, selected by default as the rules say and deselectable unless a hold explains why it cannot be selected yet,
 * the identities the selection owns and, for a captured review, the lookup summary and identity reads it rests on (the summary's
 * cached read, never polled from here; useReviewApplyModel.ts, which the step bar's count shares). The parent keeps the explicit
 * choices, each with the basis of the item it was made on, and freezes the confirmed selection.
 */
export function CatalogReviewApply({ item, choices, disabled, onChoose, onConfirm }: { item: CatalogReview; choices: Readonly<Record<string, ApplyChoice>>; disabled: boolean;
  onChoose: (key: string, choice: ApplyChoice) => void; onConfirm: (selection: ReviewApplySelection) => void }) {
  const t = useAdminText(), id = useId();
  const { model, count, reads } = useReviewApplyModel(item, choices);
  const track = (slotId: string) => { const index = item.draft.tracks.findIndex(value => value.slotId === slotId); return `${index + 1} · ${item.draft.tracks[index]?.title || '—'}`; };
  const hold = (entry: ApplyItem) => entry.hold === 'conflict' ? t('catalog_review.answer_conflict_first') : entry.hold === 'tracklist' ? t('catalog_review.number_with_tracklist')
    : t('catalog_review.off_row', { tracks: entry.offSlotIds.map(track).join(', ') });
  return <section className={styles.panel}><h2>{t('catalog_review.apply_title')}</h2><p className={styles.muted}>{t('catalog_review.apply_copy')}</p>
    {reads.some(query => query.isError) ? <div role="alert"><p>{t('common.error')}</p><button className={styles.button} type="button" disabled={reads.some(query => query.isFetching)}
      onClick={() => { for (const query of reads) if (query.isError) void query.refetch(); }}>{t('common.retry')}</button></div>
      : reads.some(query => query.isPending) && <p role="status">{t('common.loading')}</p>}
    {!model.items.length && <p>{t('catalog_review.no_changes')}</p>}
    <Suspense fallback={<p role="status">{t('common.loading')}</p>}>
      {model.items.map(entry => <Fragment key={entry.key}><article className={styles.card}>
        <label className={styles.check}><input type="checkbox" checked={entry.selected} aria-describedby={entry.hold ? `${id}-${entry.key}` : undefined}
          disabled={disabled || !item.capabilities.apply || entry.hold !== null} onChange={event => onChoose(entry.key, { checked: event.target.checked, basis: entry.basis })} />
          {t('catalog_review.select_field', { type: t(`catalog_review.target_${entry.scope}`), target: entry.title || t('common.untitled'), field: t(`field.${entry.field}`) })}</label>
        {entry.hold && <p id={`${id}-${entry.key}`} className={styles.muted}>{hold(entry)}</p>}
        <ApplyItemValues item={entry} />
      </article>{entry.key === 'album::artists' && model.selection.albumNote && <ApplyAlbumNote item={item} namingReplaced={model.selection.albumNote.namingReplaced} />}</Fragment>)}
      {model.selection.identities.length > 0 && <ApplyIdentityLines lines={model.selection.identities} />}
    </Suspense>
    <div className={styles.actions}><span>{t('catalog_review.selected', { count })}</span>
      <button className={`${styles.button} ${styles.primary}`} type="button" disabled={disabled || !item.capabilities.apply || !model.ready}
        onClick={() => onConfirm(structuredClone(model.selection))}>{t('catalog_review.apply_action', { count })}</button></div>
    {model.blocking.lookup && <p>{t('catalog_review.waiting_lookup')}</p>}
    {model.blocking.identities.length > 0 && <p>{t('catalog_review.identity_answers_first', { names: model.blocking.identities.join(', ') })}</p>}
    {item.state === 'reviewing' && item.sourceStatus === 'current' && !item.capabilities.apply && <p>{t('catalog_review.unavailable')}</p>}
  </section>;
}

/**
 * This step's count (its selected fields and members), how many changes it lists, the identity rows that need an answer and
 * whether its selection is ready to apply (no lookup or Luna AI wait, identity block or outdated read), reported to the step bar
 * without rendering anything, from the same model and reads as this step; it shares this step's chunk.
 */
export function CatalogReviewApplyCount({ item, choices, onCount }: { item: CatalogReview; choices: Readonly<Record<string, ApplyChoice>>;
  onCount: (value: { count: number; items: number; identityAnswers: number; ready: boolean }) => void }) {
  const { model, count, identity } = useReviewApplyModel(item, choices), items = model.items.length, ready = model.ready;
  const identityAnswers = identity ? identity.identities.filter(row => row.needsAnswer).length + (identity.label?.needsAnswer ? 1 : 0) : 0;
  useEffect(() => onCount({ count, items, identityAnswers, ready }), [count, items, identityAnswers, ready]);
  return null;
}
