import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ModalDialog } from '../../components/ModalDialog';
import { AdminGate, useAdminAccess, useAdminText } from './AdminAccess';
import { AdminNav } from './AdminNav';
import { adminEndpointRequest } from './adminApi';
import { pageResponse, pageMutationResponse, type AdminPage } from './catalogApi';
import { useAdminCommand } from './useAdminCommand';
import styles from './adminStyles';
function PageItems({ slug }: { slug: 'home' | 'library' }) {
  const t = useAdminText(), access = useAdminAccess();
  const [target, setTarget] = useState<{ item: AdminPage['items'][number]; index: number; visibility: 'public' | 'hidden'; revision: string } | null>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const client = useQueryClient();
  const queryKey = ['admin-imports', access.viewerId, access.epoch, access.generation, 'page', slug];
  const command = useAdminCommand(`page:${slug}`, pageMutationResponse.refine(value => value.page.slug === slug));
  const query = useQuery({ queryKey, queryFn: ({ signal }) => adminEndpointRequest(`/pages/${slug}`, pageResponse.refine(value => value.page.slug === slug), { signal }), retry: false, gcTime: 0 });
  useEffect(() => { if (command.result) { void client.cancelQueries({ queryKey }); client.setQueryData(queryKey, { page: command.result.page }); command.command.acknowledge(); void query.refetch(); } }, [command.result]);
  const locked = command.running || Boolean(command.intent) || !access.catalogVisibility;
  return <>
    <div className={styles.toolbar}><p className={styles.muted}>{t('catalog.occurrence_copy')}</p><button className={styles.button} disabled={query.isFetching} onClick={() => void query.refetch()}>{t('common.refresh')}</button></div>
    {query.isPending && <p role="status">{t('common.loading')}</p>}{query.isError && <p role="alert">{t('common.error')}</p>}
    {command.error && <div role="alert"><p>{t(`common.${command.error}`)}</p>{command.intent && <button className={styles.button} onClick={command.command.retry}>{t('common.retry_operation')}</button>}</div>}
    {query.data && <ul className={styles.cards}>{query.data.page.items.map((item, index) => <li className={styles.card} key={item.itemId}>
      <div className={styles.row}><div>
        <h2 className={styles.filename}>{index + 1} · {item.name || t('catalog.placement_name_missing')}</h2>
        <div className={styles.badges}><span className={styles.badge}>{t(`catalog.${item.itemType}`)}</span>{item.sourceMode && <span className={styles.badge}>{t(`catalog.source_${item.sourceMode}`)}</span>}<span className={styles.badge}>{t(`field.${item.visibility}`)}</span></div>
      </div><button className={styles.button} disabled={locked} onClick={() => setTarget({ item, index, visibility: item.visibility === 'public' ? 'hidden' : 'public', revision: query.data.page.revision })}>{t(item.visibility === 'public' ? 'catalog.hide' : 'catalog.show')}</button></div>
      {['missing', 'unsupported'].includes(item.referenceStatus ?? '') && <p role="status" className={styles.muted}>{t(`catalog.placement_${item.referenceStatus}`)}</p>}
      <details className={styles.details}><summary>{t('action.details')}</summary><p>{item.referenceId}</p></details>
    </li>)}</ul>}
    {target && <ModalDialog title={t('catalog.confirm_placement')} description={t('catalog.confirm_placement_copy')} headerContent={<div className={styles.target}><strong>{target.index + 1} · {target.item.name || t('catalog.placement_name_missing')}</strong><p className={styles.muted}>{t(`catalog.${target.item.itemType}`)}{target.item.sourceMode && ` · ${t(`catalog.source_${target.item.sourceMode}`)}`}</p><p className={styles.transition}>{t('catalog.visibility_change', { current: t(`field.${target.item.visibility}`), next: t(`field.${target.visibility}`) })}</p></div>} initialFocusRef={cancel} onClose={() => setTarget(null)}>

      <div className={styles.dialogActions}>
      <button ref={cancel} className={styles.button} onClick={() => setTarget(null)}>{t('common.cancel')}</button>
      <button className={`${styles.button} ${styles.primary}`} disabled={locked || target.revision !== query.data?.page.revision} onClick={() => { void client.cancelQueries({ queryKey }); command.command.run(`/pages/${slug}/items/${target.item.itemId}`, { expectedRevision: target.revision, visibility: target.visibility }); setTarget(null); }}>{t(target.visibility === 'hidden' ? 'catalog.hide' : 'catalog.show')}</button>
    </div></ModalDialog>}
  </>;
}
function Pages() {
  const t = useAdminText(); const [slug, setSlug] = useState<'home' | 'library'>('home');
  return <section className={styles.page}><AdminNav /><header className={styles.header}><h1 className={styles.title}>{t('catalog.pages')}</h1></header><div className={styles.filters}>{(['home', 'library'] as const).map(value => <button key={value} className={styles.filter} aria-pressed={slug === value} onClick={() => setSlug(value)}>{t(`catalog.${value}`)}</button>)}</div><PageItems key={slug} slug={slug} /></section>;
}
export const AdminPagesPage = () => <AdminGate><Pages /></AdminGate>;
