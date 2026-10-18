import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useAdminAccess, useAdminText } from './AdminAccess';
import { AdminNav } from './AdminNav';
import { adminEndpointRequest } from './adminTransport';
import { catalogKinds, catalogList } from './catalogApi';
import { useLocalization } from '../../localization/LocalizationProvider';
import { CatalogArtwork, catalogFallbacks, catalogMetadata, catalogName } from './CatalogPresentation';
import cardStyles from '../../components/ContentCard.module.css';
import sectionStyles from '../../components/PageSection.module.css';
import styles from './adminStyles';

/** Browses one administrator catalog category without loading editing or mutation controls. */
export function AdminCatalogInventory() {
  const t = useAdminText(), access = useAdminAccess(), { t: sharedText } = useLocalization();
  const navigate=useNavigate();
  const [params, setParams] = useSearchParams();
  const kind = catalogKinds.find(value => value === params.get('kind')) ?? 'album';
  const [targetId,setTargetId]=useState('');
  const [text, setText] = useState(''), [search, setSearch] = useState('');
  const [artworkRefresh, setArtworkRefresh] = useState(0);
  const query = useInfiniteQuery({ queryKey: ['admin-imports', access.viewerId, access.epoch, access.generation, 'catalog', kind, search], initialPageParam: null as string | null,
    queryFn: ({ signal, pageParam }) => adminEndpointRequest(`/catalog/${kind}?${new URLSearchParams({ query: search, ...(pageParam ? { cursor: pageParam } : {}) })}`, catalogList.refine(value => value.items.every(item => item.kind === kind)), { signal }), getNextPageParam: page => page.nextCursor ?? undefined, retry: false, gcTime: 0 });
  return <section className={styles.page}><AdminNav /><header className={styles.header}><div><h1 className={styles.title}>{t('catalog.title')}</h1><p className={styles.meta}>{t('catalog.private_copy')}</p></div></header>
    <div className={styles.filters}>{catalogKinds.map(value => <button className={styles.filter} key={value} aria-pressed={value === kind} onClick={() => setParams(value === 'album' ? {} : { kind: value })}>{t(`catalog.${value}`)}</button>)}</div>
    <form className={styles.toolbar} onSubmit={event => { event.preventDefault(); setSearch(text.trim()); }}><label>{t('catalog.search')}<input className={styles.input} maxLength={100} value={text} onChange={event => setText(event.target.value)} /></label><button className={styles.button}>{t('catalog.search')}</button><button className={styles.button} type="button" onClick={() => { setArtworkRefresh(value => value + 1); void query.refetch(); }}>{t('common.refresh')}</button></form>
    {query.isPending && <p role="status">{t('common.loading')}</p>}{query.isError && <p role="alert" className={styles.notice}>{t('common.error')}</p>}
    <ul className={sectionStyles.grid}>{[...new Map((query.data?.pages.flatMap(page => page.items) ?? []).map(item => [item.id, item])).values()].map(item => <li className={`${sectionStyles.cardItem} ${cardStyles.card}`} key={item.id}>
      <Link className={cardStyles.action} aria-label={catalogName(item) || sharedText(catalogFallbacks[item.kind])} aria-describedby={`catalog-summary-${item.id}`} to={`/admin/catalog/${item.kind}/${item.id}`}>
        <CatalogArtwork item={item} viewerId={access.viewerId} refresh={artworkRefresh} />
        <span className={cardStyles.copy}><span className={cardStyles.title} title={catalogName(item)}>{catalogName(item) || sharedText(catalogFallbacks[item.kind])}</span><span className={cardStyles.metadata} id={`catalog-summary-${item.id}`}>{catalogMetadata(item, t, true)}</span></span>
      </Link>
    </li>)}</ul>
    {query.isSuccess && query.data.pages[0].items.length === 0 && <p>{t('workbench.no_matches')}</p>}
    {query.hasNextPage && <button className={styles.button} disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{t('workbench.more')}</button>}
    {kind!=='organization'&&<details className={styles.panel}><summary>{t('cover.recover_known')}</summary><p className={styles.muted}>{t('cover.recover_copy')}</p><form className={styles.toolbar} onSubmit={event=>{event.preventDefault();const id=targetId.trim().toLowerCase();if(/^[a-f0-9]{24}$/.test(id))navigate(`/admin/catalog/${kind}/${id}`);}}><label>{t('cover.target_id')}<input className={styles.input} maxLength={24} value={targetId} onChange={event=>setTargetId(event.target.value)}/></label><button className={styles.button} disabled={!/^[a-f0-9]{24}$/i.test(targetId.trim())}>{t('cover.recover_known')}</button></form></details>}
  </section>;
}
