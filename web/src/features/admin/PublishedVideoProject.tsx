import { lazy, Suspense, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { AdminNav } from './AdminNav';
import { useAdminAccess } from './AdminAccess';
import { useAdminDeliveryText } from './adminPageText';
import { adminEndpointRequest } from './adminTransport';
import { adminWorkspace } from './adminWorkspace';
import { catalogResponse, type CatalogItem } from './catalogApi';
import { CatalogMediaPreview } from './CatalogMediaPreview';
import { useOnline } from './useAdminOnline';
import type { VideoProject } from './videoUploadApi';
import common from './adminStyles';
import styles from './VideoUpload.module.css';

const CatalogCover = lazy(() => import('./CatalogCover').then(module => ({ default: module.CatalogCover })));

/** Completed uploads retain their history; playback and artwork follow the current catalog owner. */
export default function PublishedVideoProject({ project, children }: { project: VideoProject; children?: ReactNode }) {
  const access = useAdminAccess(), t = useAdminDeliveryText(['video.']), online = useOnline(), client = useQueryClient();
  const [refresh, setRefresh] = useState(0), id = project.publication.mediaTrackId;
  const queryKey = ['admin-imports', access.viewerId, access.epoch, access.generation, 'catalog', 'audioTrack', id];
  const query = useQuery({ queryKey, enabled: access.active && Boolean(id), retry: false, gcTime: 0,
    queryFn: ({ signal }) => adminEndpointRequest(`/catalog/audioTrack/${id}`, catalogResponse.refine(value => value.item.kind === 'audioTrack' && value.item.id === id), { signal }) });
  const item = query.isError ? null : query.data?.item ?? null;
  const confirmed = (next: CatalogItem) => {
    if (!adminWorkspace.current(access)) return;
    void client.cancelQueries({ queryKey }); client.setQueryData(queryKey, { item: next }); setRefresh(value => value + 1);
  };
  if (!access.active) return null;
  return <section className={common.page}><AdminNav /><Link className={common.back} to="/admin/imports?source=videos">{t('common.back')}</Link>
    <header className={common.header}><div><h1 className={common.title}>{t('video.published')}</h1>
      {item && <p className={common.meta} style={{ overflowWrap: 'anywhere' }}>{'title' in item.fields ? item.fields.title : ''}</p>}
      <p className={common.muted}>{t('video.published_help')}</p></div>
      <button className={common.button} disabled={!id || !online || query.isFetching} onClick={() => { setRefresh(value => value + 1); void query.refetch(); }}>{t('video.refresh_published')}</button>
    </header>
    {project.publication.cleanupPending && <p role="status">{t('video.published_cleanup')}</p>}
    {children}
    {!online && <p role="status">{t('common.offline')}</p>}
    {id && query.isPending && <p role="status">{t('common.loading')}</p>}
    {(!id || query.isError) && <p role="alert">{t('common.error')}</p>}
    {id && <div className={styles.layout}><section><CatalogMediaPreview item={item} refresh={refresh} />
      <Link className={common.link} to={`/admin/catalog/audioTrack/${id}`}>{t('video.manage')}</Link>
    </section><div>
      {item && <div className={styles.cover} style={{ marginBottom: '1rem' }}>
        {item.coverUrl && <img key={`${item.revision}:${refresh}`} src={`${item.coverUrl}?viewer=${encodeURIComponent(access.viewerId)}`} alt={t('video.cover_preview')} />}
        <strong>{t(item.coverUrl ? 'video.cover_published' : 'video.cover_placeholder')}</strong>
      </div>}
      <Suspense fallback={<p role="status">{t('common.loading')}</p>}><CatalogCover item={item} kind="audioTrack" id={id} disabled={!online}
        approvalDisabled={query.isPending || query.isError || !item} onConfirmed={confirmed}
        onRemoved={() => { if (adminWorkspace.current(access)) void client.resetQueries({ queryKey, exact: true }); }} /></Suspense>
    </div></div>}
    <details className={common.panel}><summary>{t('video.upload_record')}</summary><dl className={styles.summary}>
      <div><dt>{t('video.title')}</dt><dd>{project.draft.title}</dd></div>
      <div><dt>{t('video.file_processing')}</dt><dd>{project.source.filename}</dd></div>
      <div><dt>{t('video.attribution')}</dt><dd>{project.draft.attribution === 'self' ? project.draft.publicName || t('video.personal') : project.references.subject?.name || t('video.attribution_unknown')}</dd></div>
      <div><dt>{t('video.album')}</dt><dd>{project.references.album?.title || t('video.no_album')}</dd></div>
    </dl></details>
    <Link className={common.link} to="/admin/videos/new">{t('video.another')}</Link>
  </section>;
}
