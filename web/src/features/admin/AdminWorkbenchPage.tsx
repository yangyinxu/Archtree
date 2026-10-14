import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { AdminGate, useAdminAccess, useAdminText } from './AdminAccess';
import { adminRequest, filters, workbenchSchema, type WorkbenchFilter } from './adminApi';
import { ImportStages, useOnline } from './AdminShared';
import { AdminNav } from './AdminNav';
import styles from './adminStyles';

function Workbench() {
  const t = useAdminText();
  const access = useAdminAccess();
  const online = useOnline();
  const [filter, setFilter] = useState<WorkbenchFilter>('all');
  const [mine, setMine] = useState(false);
  const [search, setSearch] = useState('');
  const [submitted, setSubmitted] = useState('');
  const query = useInfiniteQuery({
    queryKey: ['admin-imports', access.viewerId, access.epoch, access.generation, 'list', filter, mine, submitted],
    initialPageParam: null as string | null,
    queryFn: ({ signal, pageParam }) => {
      const params = new URLSearchParams({ filter, limit: '25' });
      if (mine) params.set('startedByMe', 'true');
      if (submitted) params.set('q', submitted);
      if (pageParam) params.set('cursor', pageParam);
      return adminRequest(`?${params}`, workbenchSchema, { signal });
    },
    getNextPageParam: page => page.nextCursor ?? undefined,
    retry: false, gcTime: 0, refetchOnWindowFocus: 'always',
    refetchInterval: query => online && query.state.data?.pages.some(page => page.items.some(item => ['running', 'queued'].includes(item.analysis.state) || item.publication === 'preparing')) ? 5000 : false
  });
  const items = [...new Map((query.data?.pages.flatMap(page => page.items) ?? []).map(item => [item.id, item])).values()];
  return <section className={styles.page}><AdminNav />
    <header className={styles.header}><h1 className={styles.title}>{t('workbench.title')}</h1><div className={styles.check}>
      <button className={styles.button} type="button" disabled={query.isFetching || !online} onClick={() => void query.refetch()}>{t('common.refresh')}</button>
      {access.imports && <Link className={`${styles.link} ${styles.primary}`} to="/admin/imports/new">{t('workbench.new')}</Link>}
    </div></header>
    <div className={styles.filters} aria-label={t('workbench.title')}>
      {filters.map(value => <button type="button" className={styles.filter} aria-pressed={value === filter} key={value} onClick={() => setFilter(value)}>
        {t(`workbench.${value}`)}{query.data && ` (${query.data.pages[0].counts[value]})`}</button>)}
    </div>
    <form className={styles.toolbar} onSubmit={event => { event.preventDefault(); setSubmitted(search.trim()); }}>
      <label className={styles.field}>{t('workbench.search')}<input className={styles.input} value={search} maxLength={100} onChange={event => setSearch(event.target.value)} /></label>
      <div className={styles.check}><button className={styles.button} type="submit">{t('workbench.search')}</button>
      <label className={`${styles.check} ${styles.meta}`}><input type="checkbox" checked={mine} onChange={event => setMine(event.target.checked)} />{t('workbench.mine')}</label></div>
    </form>
    {!online && <p role="status" className={styles.error}>{t('common.offline')}</p>}
    {query.isPending && online && <p role="status">{t('common.loading')}</p>}
    {query.isError && <div role="alert" className={styles.error}><p>{t('common.error')}</p><button className={styles.button} type="button" onClick={() => void query.refetch()}>{t('common.retry')}</button></div>}
    {query.isSuccess && items.length === 0 && <p className={styles.empty}>{t(filter === 'all' && !mine && !submitted ? 'workbench.empty' : 'workbench.no_matches')}</p>}
    <ul className={styles.cards}>{items.map(item => <li className={styles.card} key={item.id}>
      <h2><Link className={styles.itemLink} to={`/admin/imports/${item.id}`}>{item.title || item.rootLabel || t('common.untitled')}</Link></h2>
      <p className={styles.muted}>{item.artistName}</p><ImportStages item={item} />
      <p className={styles.muted}>{t('common.last_updated', { date: new Date(item.updatedAt).toLocaleString() })}</p>
    </li>)}</ul>
    {query.hasNextPage && <button className={styles.button} disabled={query.isFetchingNextPage || !online} onClick={() => void query.fetchNextPage()}>{t('workbench.more')}</button>}
  </section>;
}
export const AdminWorkbenchPage = () => <AdminGate><Workbench /></AdminGate>;
