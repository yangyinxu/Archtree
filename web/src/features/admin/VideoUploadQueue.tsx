import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useAdminAccess } from './AdminAccess';
import { useAdminDeliveryText } from './adminPageText';
import { adminEndpointRequest } from './adminTransport';
import { videoListSchema, type VideoProject } from './videoUploadApi';
import { useOnline } from './useAdminOnline';
import common from './adminStyles';

/** A server task's status keeps failed publication and pending cleanup separate from source transfer. */
export function videoQueueState(item: VideoProject) {
  if (item.publication.cleanupPending) return 'cleanup';
  if (item.publication.state === 'complete') return 'complete';
  if (item.stage === 'cancelled') return 'cancelled';
  if (item.source.status === 'unknown' || item.source.status === 'pending') return 'unknown';
  if (item.source.status === 'failed' || item.processing.state === 'failed' || item.publication.state === 'failed') return 'failed';
  if (item.stage === 'review') return 'review';
  return 'progress';
}

/** An additive workbench queue of durable private Video projects, independent of Album imports and reviews. */
export function VideoUploadQueue() {
  const t = useAdminDeliveryText(['video.']), access = useAdminAccess(), online = useOnline();
  const [filter, setFilter] = useState('all');
  const query = useInfiniteQuery({ queryKey: ['admin-video-projects', access.viewerId, access.epoch, access.generation], initialPageParam: null as string | null,
    queryFn: ({ signal, pageParam }) => adminEndpointRequest(`/video-projects${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ''}`, videoListSchema, { signal }),
    getNextPageParam: page => page.nextCursor ?? undefined, retry: false, gcTime: 0,
    refetchInterval: state => online && state.state.data?.pages.some(page => page.items.some(item => ['upload', 'validate', 'publish'].includes(item.stage) || ['queued', 'running'].includes(item.frame.state) || item.publication.cleanupPending)) ? 5000 : false });
  const items = [...new Map((query.data?.pages.flatMap(page => page.items) ?? []).map(item => [item.id, item])).values()], shown = items.filter(item => filter === 'all' || videoQueueState(item) === filter);
  return <>
    <div className={common.filters} role="group" aria-label={t('video.queue')}>
      {['all', 'progress', 'review', 'failed', 'unknown', 'complete', 'cleanup', 'cancelled'].map(value => <button className={common.filter} type="button" aria-pressed={value === filter} key={value} onClick={() => setFilter(value)}>{t(`video.queue_${value}`)}</button>)}
      <button className={common.button} type="button" disabled={query.isFetching || !online} onClick={() => void query.refetch()}>{t('common.refresh')}</button>
    </div>
    {query.isPending && <p role="status">{t('common.loading')}</p>}{query.isError && <div role="alert"><p>{t('common.error')}</p><button className={common.button} onClick={() => void query.refetch()}>{t('common.retry')}</button></div>}
    {!online && <p role="status">{t('common.offline')}</p>}
    {query.isSuccess && !shown.length && <p>{t('video.queue_empty')}</p>}
    <ul className={common.cards}>{shown.map(item => <li className={common.card} key={item.id}><h2><Link className={common.itemLink} to={`/admin/videos/${item.id}`}>{item.draft.title || item.source.filename}</Link></h2><p>{item.source.filename}</p><p>{t(`video.queue_${videoQueueState(item)}`)}</p><Link className={common.link} to={`/admin/videos/${item.id}`}>{t('video.continue')}</Link></li>)}</ul>
    {query.hasNextPage && <button className={common.button} type="button" disabled={!online || query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{t('workbench.more')}</button>}
  </>;
}
