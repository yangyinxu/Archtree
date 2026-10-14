import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { ApiError } from '../../api/client';
import { AdminGate, useAdminAccess, useAdminText } from './AdminAccess';
import { AdminNav } from './AdminNav';
import { adminEndpointRequest } from './adminTransport';
import { adminWorkspace } from './adminWorkspace';
import { catalogKinds, catalogList, catalogResponse, catalogMutationResponse, catalogPatch, type CatalogItem, type CatalogKind } from './catalogApi';
import { useAdminCommand } from './useAdminCommand';
import { useOnline } from './useAdminOnline';
import type { CatalogEditSnapshot } from './CatalogEditConfirmation';
import styles from './adminStyles';
const CatalogCover = lazy(() => import('./CatalogCover').then(module => ({ default: module.CatalogCover })));
const CatalogFields = lazy(() => import('./CatalogFields').then(module => ({ default: module.CatalogFields })));
const CatalogReviewStart = lazy(() => import('./CatalogReviewStart').then(module => ({ default: module.CatalogReviewStart })));
const CatalogEditConfirmation = lazy(() => import('./CatalogEditConfirmation').then(module => ({ default: module.CatalogEditConfirmation })));

function CatalogInventory() {
  const t = useAdminText(), access = useAdminAccess();
  const navigate=useNavigate();
  const [kind, setKind] = useState<CatalogKind>('album');
  const [targetId,setTargetId]=useState('');
  const [text, setText] = useState(''), [search, setSearch] = useState('');
  const query = useInfiniteQuery({ queryKey: ['admin-imports', access.viewerId, access.epoch, access.generation, 'catalog', kind, search], initialPageParam: null as string | null,
    queryFn: ({ signal, pageParam }) => adminEndpointRequest(`/catalog/${kind}?${new URLSearchParams({ query: search, ...(pageParam ? { cursor: pageParam } : {}) })}`, catalogList.refine(value => value.items.every(item => item.kind === kind)), { signal }), getNextPageParam: page => page.nextCursor ?? undefined, retry: false, gcTime: 0 });
  return <section className={styles.page}><AdminNav /><header className={styles.header}><div><h1 className={styles.title}>{t('catalog.title')}</h1><p className={styles.meta}>{t('catalog.private_copy')}</p></div></header>
    <div className={styles.filters}>{catalogKinds.map(value => <button className={styles.filter} key={value} aria-pressed={value === kind} onClick={() => setKind(value)}>{t(`catalog.${value}`)}</button>)}</div>
    <form className={styles.toolbar} onSubmit={event => { event.preventDefault(); setSearch(text.trim()); }}><label>{t('catalog.search')}<input className={styles.input} maxLength={100} value={text} onChange={event => setText(event.target.value)} /></label><button className={styles.button}>{t('catalog.search')}</button><button className={styles.button} type="button" onClick={() => void query.refetch()}>{t('common.refresh')}</button></form>
    {query.isPending && <p role="status">{t('common.loading')}</p>}{query.isError && <p role="alert" className={styles.notice}>{t('common.error')}</p>}
    <ul className={styles.cards}>{[...new Map((query.data?.pages.flatMap(page => page.items) ?? []).map(item => [item.id, item])).values()].map(item => <li className={styles.card} key={item.id}><div className={styles.row}><Link className={styles.itemLink} to={`/admin/catalog/${kind}/${item.id}`}>{'name' in item.fields ? item.fields.name : item.fields.title}</Link><span className={styles.badge}>{t(`field.${item.visibility}`)}</span></div>
      <div className={styles.actions}><Link className={styles.link} to={`/admin/catalog/${kind}/${item.id}`}>{t('catalog_review.manual_edit')}</Link>
        {kind === 'album' && <Suspense fallback={null}><CatalogReviewStart item={item} /></Suspense>}</div>
      {(kind === 'album' || kind === 'audioTrack') && access.conversion && <Link className={styles.link} to={`/admin/conversions?${kind === 'album' ? 'album' : 'track'}=${item.id}`}>{t('conversion.existing')}</Link>}
    </li>)}</ul>
    {query.isSuccess && query.data.pages[0].items.length === 0 && <p>{t('workbench.no_matches')}</p>}
    {query.hasNextPage && <button className={styles.button} disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{t('workbench.more')}</button>}
    {kind!=='organization'&&<details className={styles.panel}><summary>{t('cover.recover_known')}</summary><p className={styles.muted}>{t('cover.recover_copy')}</p><form className={styles.toolbar} onSubmit={event=>{event.preventDefault();const id=targetId.trim().toLowerCase();if(/^[a-f0-9]{24}$/.test(id))navigate(`/admin/catalog/${kind}/${id}`);}}><label>{t('cover.target_id')}<input className={styles.input} maxLength={24} value={targetId} onChange={event=>setTargetId(event.target.value)}/></label><button className={styles.button} disabled={!/^[a-f0-9]{24}$/i.test(targetId.trim())}>{t('cover.recover_known')}</button></form></details>}
  </section>;
}
interface CatalogBuffer { base: CatalogItem; fields: CatalogItem['fields']; visibility: 'public' | 'hidden'; dirty: boolean }
function CatalogEditor({ kind, id }: { kind: CatalogKind; id: string }) {
  const t = useAdminText(), access = useAdminAccess(), online = useOnline();
  const key = `catalog:${kind}:${id}`, path = `/catalog/${kind}/${id}`;
  const [edit, setEdit] = useState<CatalogBuffer | null>(() => adminWorkspace.buffer(key) ?? null);
  const [confirm, setConfirm] = useState<CatalogEditSnapshot | null>(null);
  const media = useRef<HTMLAudioElement>(null);
  const client = useQueryClient();
  const queryKey = ['admin-imports', access.viewerId, access.epoch, access.generation, 'catalog', kind, id];
  const matches = (value: { item: CatalogItem }) => value.item.kind === kind && value.item.id === id;
  const mutation = useAdminCommand(key, catalogMutationResponse.refine(matches));
  const query = useQuery({ queryKey, queryFn: ({ signal }) => adminEndpointRequest(path, catalogResponse.refine(matches), { signal }), retry: false, gcTime: 0 });
  const missing = query.error instanceof ApiError && query.error.status === 404;
  useEffect(() => { const item = query.data?.item; if (item) setEdit(previous => previous?.dirty ? previous : { base: item, fields: item.fields, visibility: item.visibility, dirty: false }); }, [query.data]);
  useEffect(() => { if (edit) adminWorkspace.retain(key, edit, access); }, [edit]);
  useEffect(() => {
    // A confirmed missing owner cannot supply a revision or metadata for recovery.
    if (missing) { setEdit(null); setConfirm(null); adminWorkspace.forget(key); }
  }, [missing, key]);
  useEffect(() => { if (mutation.result) { const item = mutation.result.item; void client.cancelQueries({ queryKey }); client.setQueryData(queryKey, { item }); setEdit({ base: item, fields: item.fields, visibility: item.visibility, dirty: false }); mutation.command.acknowledge(); void query.refetch(); } }, [mutation.result]);
  useEffect(() => { const element = media.current; return () => { if (element) { element.pause(); element.removeAttribute('src'); element.load(); } }; }, [edit?.base.mediaUrl]);
  const locked = mutation.running || Boolean(mutation.intent) || !online;
  // Reverting local values must not hide a newer revision that was already observed.
  const conflict = Boolean(edit && query.data && edit.base.revision !== query.data.item.revision);
  const confirmationStale = Boolean(confirm && query.data && confirm.item.revision !== query.data.item.revision);
  // Returning every field to its saved value must also unlock review and artwork actions.
  const updateEdit = (fields: CatalogItem['fields'], visibility: 'public' | 'hidden') => {
    if (!edit) return;
    const patch = catalogPatch(edit.base, fields, visibility);
    setEdit({ ...edit, fields, visibility, dirty: Boolean(patch.fields || patch.visibility) });
  };
  const item = missing ? undefined : edit?.base;
  return <section className={styles.page}><AdminNav /><header className={styles.header}><div><h1 className={styles.title}>{item ? ('name' in item.fields ? item.fields.name : item.fields.title) || t('catalog.edit') : t('catalog.edit')}</h1><p className={styles.meta}>{t(`catalog.${kind}`)}</p></div><button className={styles.button} disabled={query.isFetching || locked} onClick={() => void query.refetch()}>{t('common.refresh')}</button></header>
    {!online && <p role="status">{t('common.offline')}</p>}{query.isPending && <p role="status">{t('common.loading')}</p>}{query.isError && <p role="alert" className={styles.notice}>{t(missing ? 'catalog.content_missing' : 'common.error')}</p>}
    {mutation.error && <div className={styles.error} role="alert"><p>{t(`common.${mutation.error}`)}</p>{mutation.intent && <button className={styles.button} onClick={mutation.command.retry}>{t('common.retry_operation')}</button>}</div>}
    {item && edit && <>
      <p className={styles.notice}>{t('catalog.direct_edit_copy')}</p>
      {kind === 'album' && <div className={styles.actions}><Suspense fallback={null}><CatalogReviewStart item={item} disabled={locked || conflict || edit.dirty} /></Suspense>
        {edit.dirty && <p className={styles.muted}>{t('catalog_review.save_first')}</p>}</div>}
      {item.coverUrl && <img alt={t('catalog.cover')} src={`${item.coverUrl}?viewer=${encodeURIComponent(access.viewerId)}`} className={styles.artwork} width={140} height={140} />}
      {(kind === 'album' || kind === 'audioTrack') && access.conversion && !edit.dirty && !conflict && <Link className={styles.link} to={`/admin/conversions?${kind === 'album' ? 'album' : 'track'}=${id}`}>{t('conversion.existing')}</Link>}
      {item.mediaUrl && <audio ref={media} aria-label={t('catalog.preview')} controls preload="none" src={`${item.mediaUrl}?viewer=${encodeURIComponent(access.viewerId)}`} style={{ maxWidth: '100%' }} />}
      {conflict && <div className={styles.error} role="alert"><p>{t('common.conflict')}</p><details><summary>{t('review.saved_version')}</summary><pre className={styles.rawDraft}>{JSON.stringify(query.data!.item.fields, null, 2)}</pre></details><button className={styles.button} onClick={() => { const next = query.data!.item; setEdit({ base: next, fields: next.fields, visibility: next.visibility, dirty: false }); }}>{t('review.load_saved')}</button></div>}
      <form className={styles.panel} onSubmit={event => { event.preventDefault(); if (!locked && !conflict) {
        const patch = catalogPatch(edit.base, edit.fields, edit.visibility);
        if (patch.fields || patch.visibility) setConfirm(structuredClone({ item: edit.base, patch }));
      } }}>
        <header className={styles.sectionHeader}><h2>{t('layout.catalog_details')}</h2></header>
        <Suspense fallback={<p role="status">{t('common.loading')}</p>}><CatalogFields item={item} fields={edit.fields} disabled={locked || !item.capabilities.editing} onChange={fields => updateEdit(fields, edit.visibility)} /></Suspense>
        <label className={styles.field}>{t('field.visibility')}<select className={styles.input} value={edit.visibility} disabled={locked || !item.capabilities.visibility} onChange={event => updateEdit(edit.fields, event.target.value as 'public' | 'hidden')}><option value="public">{t('field.public')}</option><option value="hidden">{t('field.hidden')}</option></select></label>
        <p className={styles.muted}>{t('catalog.visibility_copy')}</p>
        {item.effectiveVisibility !== item.visibility && <p>{t('catalog.parent_hidden')}</p>}
        <button className={`${styles.button} ${styles.primary}`} disabled={locked || !edit.dirty || conflict || !item.capabilities.editing}>{t('catalog.save')}</button>
      </form>
      {confirm && <Suspense fallback={<p role="status">{t('common.loading')}</p>}><CatalogEditConfirmation snapshot={confirm}
        stale={confirmationStale} disabled={locked || conflict || confirm.item.revision !== query.data?.item.revision}
        onClose={() => setConfirm(null)} onConfirm={() => {
          if (locked || conflict || confirm.item.revision !== query.data?.item.revision) return;
          setConfirm(null); void client.cancelQueries({ queryKey }); mutation.command.run(path, confirm.patch);
        }} /></Suspense>}
    </>}
    {kind !== 'organization' && <Suspense fallback={<p role="status">{t('common.loading')}</p>}><CatalogCover item={item??null} kind={kind} id={id} disabled={locked || (!missing && (conflict || Boolean(edit?.dirty))) || (item ? !item.capabilities.editing : !missing)} onConfirmed={next => { void client.cancelQueries({ queryKey }); client.setQueryData(queryKey, { item: next }); setEdit({ base: next, fields: next.fields, visibility: next.visibility, dirty: false }); }} onRemoved={()=>{setEdit(null);adminWorkspace.retain(key,null,access);void client.resetQueries({queryKey,exact:true});}} /></Suspense>}
  </section>;
}
export function AdminCatalogPage({ kind, id }: { kind?: CatalogKind; id?: string }) {
  return <AdminGate>{kind && id ? <CatalogEditor key={`${kind}:${id}`} kind={kind} id={id} /> : <CatalogInventory />}</AdminGate>;
}
