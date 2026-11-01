import { useEffect, useId, useRef, useState } from 'react';
import { ChevronRight, Circle, Copy, GalleryHorizontal, LayoutGrid, List, RefreshCw, TriangleAlert } from 'lucide-react';
import { useAdminPageText } from './adminPageText';
import { adminWorkspace } from './adminWorkspace';
import type { AdminPage } from './catalogApi';
import styles from './AdminPagesPage.module.css';

type Placement = AdminPage['items'][number];
const typeIcons = { carousel: GalleryHorizontal, grid: LayoutGrid, list: List };

/** Reuses the exact placement type glyph in normal, adjustment and review presentations. */
export function PagePlacementTypeIcon({ item, size = 23 }: { item: Placement; size?: number }) {
  const Icon = typeIcons[item.itemType];
  return <Icon size={size} strokeWidth={1.6} aria-hidden />;
}

/** Visibility remains a saved fact while order changes are only a local draft. */
export function PagePlacementVisibility({ item }: { item: Placement }) {
  const t = useAdminPageText();
  return <span className={`${styles.visibility} ${item.visibility === 'public' ? styles.public : ''}`}><Circle size={7} fill="currentColor" strokeWidth={0} aria-hidden />{t(`field.${item.visibility}`)}</span>;
}

/** Source metadata omits absent values and separators without guessing a legacy source mode. */
export function PagePlacementMetadata({ item }: { item: Placement }) {
  const t = useAdminPageText();
  return <p className={styles.metadata}><span>{t(`catalog.${item.itemType}`)}</span>{item.sourceMode && <><span aria-hidden> · </span><span>{t(`catalog.source_${item.sourceMode}`)}</span></>}</p>;
}

/** Broken references remain visible in both the saved list and the exact-placement approval. */
export function PageReferenceWarning({ item }: { item: Placement }) {
  const t = useAdminPageText();
  return ['missing', 'unsupported'].includes(item.referenceStatus ?? '')
    ? <p className={styles.warning} role="status"><TriangleAlert size={15} aria-hidden />{t(`catalog.placement_${item.referenceStatus}`)}</p> : null;
}

/** Presents a saved placement with a distinct status, explicit action and inline technical details. */
export function PagePlacementRow({ item, index, locked, pending, onChange }: {
  item: Placement; index: number; locked: boolean; pending: boolean; onChange: (opener: HTMLButtonElement, fallback: HTMLButtonElement | null) => void;
}) {
  const t = useAdminPageText(), detailsId = useId();
  const [expanded, setExpanded] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle');
  const detailsButton = useRef<HTMLButtonElement>(null), copyAttempt = useRef(0), currentReference = useRef(item.referenceId);
  currentReference.current = item.referenceId;
  useEffect(() => {
    copyAttempt.current++; setCopyState('idle');
    return () => { copyAttempt.current++; };
  }, [item.referenceId]);
  const name = item.name || t('catalog.placement_name_missing');
  const hidden = item.visibility === 'hidden';
  /** Clipboard completion belongs only to the account and administrator view that initiated it. */
  async function copyReference() {
    const guard = adminWorkspace.capture();
    const reference = item.referenceId, attempt = ++copyAttempt.current;
    setCopyState('copying');
    const current = () => adminWorkspace.current(guard) && currentReference.current === reference && copyAttempt.current === attempt;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(reference);
      if (current()) setCopyState('copied');
    } catch {
      if (current()) setCopyState('failed');
    }
  }
  return <li className={`${styles.placement} ${hidden ? styles.hidden : ''}`}>
    <span className={styles.position} aria-hidden>{String(index + 1).padStart(2, '0')}</span>
    <span className={styles.typeIcon}><PagePlacementTypeIcon item={item} /></span>
    <div className={styles.identity}><h3 aria-label={`${index + 1} · ${name}`} className={!item.name ? styles.unnamed : undefined}>{name}</h3>
      <PagePlacementMetadata item={item} /><PageReferenceWarning item={item} />
    </div>
    <PagePlacementVisibility item={item} />
    <div className={styles.actions}>
      <button type="button" className={styles.action} disabled={locked} onClick={event => onChange(event.currentTarget, detailsButton.current)}>{pending && <RefreshCw size={15} className={styles.spinning} aria-hidden />}{t(pending ? 'pages.updating' : hidden ? 'catalog.show' : 'catalog.hide')}</button>
      <button type="button" ref={detailsButton} className={styles.disclosure} aria-expanded={expanded} aria-controls={detailsId} onClick={() => { copyAttempt.current++; setExpanded(value => !value); setCopyState('idle'); }}>
        <ChevronRight size={16} className={expanded ? styles.expanded : undefined} aria-hidden />{t(expanded ? 'pages.hide_details' : 'action.details')}
      </button>
    </div>
    <div className={styles.details} id={detailsId} hidden={!expanded}>
      <span>{t('pages.reference_id')}</span><code>{item.referenceId}</code>
      <button type="button" className={styles.copy} disabled={copyState === 'copying'} aria-label={t('pages.copy_reference')} onClick={() => void copyReference()}>
        <Copy size={15} aria-hidden />{t('pages.copy')}
      </button>
      <span role="status" className={copyState === 'failed' ? styles.copyError : undefined}>{copyState === 'failed' ? t('pages.copy_failed') : copyState === 'copied' ? t('pages.copied') : ''}</span>
    </div>
  </li>;
}
