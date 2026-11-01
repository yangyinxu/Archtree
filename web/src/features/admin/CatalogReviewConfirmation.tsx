import { Fragment, lazy, Suspense, useEffect, useRef, useState, type ComponentProps, type ComponentType } from 'react';
import { useAdminText } from './AdminAccess';
import { entriesByline } from './artistEntriesByline';
import { CatalogReviewCompactRows } from './CatalogReviewCompactRows';
import type * as Items from './CatalogReviewApplyItems';
import type { CatalogReviewFrozen } from './useCatalogReviewPrepare';
import styles from './adminStyles';

/** Stands in for the full values when their chunk cannot load (a deploy replaced it); the compact rows above stay readable. */
function ItemsUnavailable() { const t = useAdminText(); return <p role="alert">{t('common.reload')}</p>; }
/** The read-only value views the update range shares, loaded as their own chunk only when shown. */
const view = <P extends object>(pick: (module: typeof Items) => ComponentType<P>) =>
  lazy<ComponentType<P>>(() => import('./CatalogReviewApplyItems').then(module => ({ default: pick(module) }), () => ({ default: ItemsUnavailable })));
const ApplyItemSummary = view<ComponentProps<typeof Items.ApplyItemSummary>>(module => module.ApplyItemSummary);
const ApplyAlbumNote = view<ComponentProps<typeof Items.ApplyAlbumNote>>(module => module.ApplyAlbumNote);
const ApplyIdentityLines = view<ComponentProps<typeof Items.ApplyIdentityLines>>(module => module.ApplyIdentityLines);

/** How many changes a frozen selection updates: its fields and member lines, in "项" (items). */
const countOf = (frozen: CatalogReviewFrozen) => frozen.selection.fields.length + frozen.selection.memberCredits.length;

/**
 * The inline final confirmation of an Album completion's update (docs/features/admin-workbench.md, the confirmation): a region
 * named as a dialog but not modal, shown above the action bar, whose back and confirm buttons it describes (`summaryId`). It
 * shows the frozen selection only, never a refreshed review: the Album and its primary Artists, that the draft is saved and
 * checked (and that the stored candidates were compared again only when `compared`), the extra release data the save found and
 * left out, one compact row per affected Track and per Album value, the Artists and Organizations to be reused or created, the full
 * original and new values behind a disclosure rendered once opened, and that artwork, audio and visibility stay unchanged. It stays
 * in view, busy, while applying. Shown below the editing section, it scrolls into view when it appears, clear of the sticky bar
 * (the scroll container's bottom scroll padding is the bar's height): the nearest edge, so a tall one shows its top.
 */
export function CatalogReviewConfirmation({ frozen, compared, applying, titleId, summaryId }: { frozen: CatalogReviewFrozen; compared: boolean; applying: boolean;
  titleId: string; summaryId: string }) {
  const t = useAdminText(), [open, setOpen] = useState(false), { item, selection } = frozen, count = countOf(frozen);
  const section = useRef<HTMLElement>(null);
  useEffect(() => { section.current?.scrollIntoView?.({ block: 'nearest' }); }, []);
  const artists = entriesByline(item.draft.album.artists.filter(entry => entry.role === 'primary'));
  return <section ref={section} role="dialog" aria-modal="false" aria-labelledby={titleId} aria-describedby={summaryId} aria-busy={applying} className={styles.panel}>
    <h2 id={titleId}>{t('catalog_review.confirm_title')}</h2>
    <p className={styles.meta}>{[item.source.album.title || t('common.untitled'), artists].filter(Boolean).join(' / ')}</p>
    <p id={summaryId}>{t('catalog_review.confirm_summary', { count })}</p>
    <p className={styles.muted}>{t(compared && frozen.numbersSaved ? 'catalog_review.confirm_compared' : 'catalog_review.confirm_checked')}</p>
    {frozen.extra && <p role="note" className={styles.notice}>{t('catalog_review.confirm_extra')}</p>}
    <CatalogReviewCompactRows item={item} fields={selection.fields} members={selection.memberCredits} items={selection.items} done={false} />
    {selection.identities.length > 0 && <Suspense fallback={null}><ApplyIdentityLines lines={selection.identities} /></Suspense>}
    <details className={styles.details} onToggle={event => setOpen(event.currentTarget.open)}><summary>{t('catalog_review.confirm_full', { count })}</summary>
      {open && <Suspense fallback={<p role="status">{t('common.loading')}</p>}>{selection.items.map(entry => <Fragment key={entry.key}><ApplyItemSummary item={entry} />
        {entry.key === 'album::artists' && selection.albumNote && <ApplyAlbumNote item={item} namingReplaced={selection.albumNote.namingReplaced} />}</Fragment>)}</Suspense>}</details>
    <p>{t('catalog_review.confirm_unchanged')}</p>
  </section>;
}

/**
 * An update whose outcome is unknown (docs/features/admin-workbench.md, the unknown view): a lost connection does not mean the update
 * failed, the frozen compact rows when this page kept them, and that checking reads the same operation and never updates twice;
 * once a read found the review still unapplied (`queried`), that the same operation may be sent again. Its heading takes the focus
 * when `focus` is or becomes true (this page's own apply became unknown), never for a review opened with an unknown apply.
 */
export function CatalogReviewUnknown({ frozen, queried, focus }: { frozen: CatalogReviewFrozen | null; queried: boolean; focus: boolean }) {
  const t = useAdminText(), heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (focus) heading.current?.focus(); }, [focus]);
  return <section aria-labelledby="catalog-review-unknown" className={styles.panel}>
    <h2 id="catalog-review-unknown" ref={heading} tabIndex={-1}>{t('catalog_review.unknown_title')}</h2>
    <p>{t(queried ? 'catalog_review.unknown_pending' : 'catalog_review.unknown_copy')}</p>
    {frozen && <CatalogReviewCompactRows item={frozen.item} fields={frozen.selection.fields} members={frozen.selection.memberCredits} items={frozen.selection.items} done={false} />}
    <p className={styles.muted}>{t('catalog_review.unknown_note')}</p>
  </section>;
}
