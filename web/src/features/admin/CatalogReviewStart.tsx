import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { ModalDialog } from '../../components/ModalDialog';
import { useAdminAccess, useAdminText } from './AdminAccess';
import type { CatalogItem } from './catalogApi';
import { useCatalogReviewCommand } from './useCatalogReviewCommand';
import { useOnline } from './useAdminOnline';
import styles from './adminStyles';

/** Creating a private snapshot is explicit and separate from paid analysis or catalog changes. */
export function CatalogReviewStart({ item, disabled = false }: { item: CatalogItem; disabled?: boolean }) {
  const t = useAdminText(), access = useAdminAccess(), online = useOnline(), navigate = useNavigate();
  const [target, setTarget] = useState<CatalogItem | null>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const mutation = useCatalogReviewCommand(`create:${item.id}`, { albumId: item.id });
  const locked = disabled || mutation.running || Boolean(mutation.intent) || !online;
  const canCreate = item.capabilities.editing && access.catalogEditing;
  useEffect(() => {
    if (!mutation.result) return;
    const id = mutation.result.item.id;
    mutation.command.acknowledge();
    navigate(`/admin/catalog-reviews/${id}`);
  }, [mutation.result, navigate]);
  if (item.kind !== 'album') return null;
  return <>
    <button className={styles.button} type="button" disabled={locked || !canCreate}
      onClick={() => setTarget(item)}>{t('catalog_review.create')}</button>
    {!canCreate && <p className={styles.muted}>{t('catalog_review.unavailable')}</p>}
    {mutation.error && <div role="alert" className={styles.error}><p>{t(`common.${mutation.error}`)}</p>
      {mutation.intent && <button className={styles.button} type="button" disabled={mutation.running || !online} onClick={mutation.command.retry}>{t('common.retry_operation')}</button>}
    </div>}
    {target?.kind === 'album' && <ModalDialog title={t('catalog_review.create')} description={t('catalog_review.create_copy')}
      headerContent={<div className={styles.target}><strong>{target.fields.title || t('common.untitled')}</strong></div>}
      initialFocusRef={cancel} onClose={() => setTarget(null)}>
      <div className={styles.dialogActions}><button className={styles.button} ref={cancel} type="button" onClick={() => setTarget(null)}>{t('common.cancel')}</button>
        <button className={`${styles.button} ${styles.primary}`} type="button" disabled={locked || !canCreate || target.revision !== item.revision}
          onClick={() => { if (locked || !canCreate || target.revision !== item.revision) return; setTarget(null); mutation.command.run('/catalog-reviews', { albumId: target.id, expectedRevision: target.revision }, 'POST'); }}>{t('catalog_review.create_confirm')}</button></div>
    </ModalDialog>}
  </>;
}
