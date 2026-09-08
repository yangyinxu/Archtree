import { lazy, Suspense, useMemo, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import type { ContentSummary, LibraryContentType, LibraryItem, LibrarySort } from '../../api/contentSchemas';
import { getLibraryPage, listenerQueryKeys } from '../../api/listener';
import { playlistPageQuery } from '../../api/playlists';
import { recentlyPlayedQuery } from '../../api/recentPlayback';
import { listenerCapabilitiesQuery } from '../../api/listenerCapabilities';
import { browserSessionQuery } from '../../api/session';
import { useSectionAuthentication, SectionError } from './LibrarySectionState';
import { useLocalization } from '../../localization/LocalizationProvider';
import styles from './LibraryPage.module.css';

const PlaylistSummaryList = lazy(() => import('../playlists/PlaylistSummaryList').then((module) => ({ default: module.PlaylistSummaryList })));
const NewPlaylistButton = lazy(() => import('../playlists/PlaylistControls').then((module) => ({ default: module.NewPlaylistButton })));

const DeferredMusicRows = lazy(() => import('./LibraryMusicRows'));
/** Load playable row code before exposing its Play controls. */
const MusicRows = (props: import('./LibraryMusicRows').MusicRowsProps) => <Suspense fallback={null}><DeferredMusicRows {...props} /></Suspense>;

/** Adapts the existing saved-content DTO without changing the Save contract. */
const librarySummary = (item: LibraryItem): ContentSummary => item.contentType === 'album'
  ? { contentType: 'album', id: item.contentId, title: item.album.title,
      artworkUrl: item.album.coverArtUrl, artistNames: item.creator ? [item.creator] : [],
      releaseDate: item.album.releaseDate }
  : { contentType: 'audioTrack', id: item.contentId, title: item.audioTrack.title,
      artworkUrl: item.audioTrack.displayCoverArtUrl || item.audioTrack.coverArtUrl,
      artistNames: item.creator ? [item.creator] : [], albumId: item.audioTrack.albumId,
      albumTitle: null, duration: item.audioTrack.duration, mediaType: item.audioTrack.mediaType,
      streamUrl: item.audioTrack.streamUrl ?? '' };

type Section = 'overview' | 'saved' | 'recent' | 'playlists';

/** Fetches saved titles with server-side filtering before cursor pagination. */
const SavedSection = ({ viewerId, preview }: { viewerId: string; preview: boolean }) => {
  const { t } = useLocalization();
  const [type, setType] = useState<LibraryContentType | ''>('');
  const [sort, setSort] = useState<LibrarySort>('recentActivity');
  const [query, setQuery] = useState('');
  const options = useMemo(() => ({ contentTypes: type ? [type] : [], sort, query, limit: preview ? 4 : 30 }), [type, sort, query, preview]);
  const result = useInfiniteQuery({
    queryKey: listenerQueryKeys.library(viewerId, options),
    queryFn: ({ pageParam, signal }) => getLibraryPage(viewerId, { ...options, cursor: pageParam }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined
  });
  useSectionAuthentication(result.error);
  const rows = [...new Map((result.data?.pages ?? []).flatMap((page) => page.items)
    .map((item) => [`${item.contentType}:${item.contentId}`, item])).values()];
  return <section className={styles.section} aria-labelledby="saved-heading">
    <div className={styles.sectionHeading}><h2 id="saved-heading">{t('library.nav.saved_music')}</h2>
      {preview && <Link to="?section=saved">{t('library.action.view_all')}</Link>}
    </div>
    {!preview && <>
      <div className={styles.toolbar}>
        <label className={styles.searchControl}>{t('library.search.saved')}<input type="search" maxLength={100} value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        <label className={styles.sortControl}><span>{t('library.sort.label')}</span>
          <select value={sort} onChange={(event) => setSort(event.target.value as LibrarySort)}>
            <option value="recentActivity">{t('library.sort.recent_activity')}</option>
            <option value="recentlySaved">{t('library.sort.recently_saved')}</option>
            <option value="recentlyPlayed">{t('library.sort.recently_played')}</option>
          </select>
        </label>
      </div>
      <div className={styles.filters} role="group" aria-label={t('library.filters.label')}>
        <button type="button" aria-pressed={type === ''} onClick={() => setType('')}>{t('library.filter.all')}</button>
        <button type="button" aria-pressed={type === 'album'} onClick={() => setType('album')}>{t('common.label.albums')}</button>
        <button type="button" aria-pressed={type === 'audioTrack'} onClick={() => setType('audioTrack')}>{t('common.label.songs')}</button>
      </div>
    </>}
    {result.isPending ? <p aria-busy="true">{t('library.loading')}</p>
      : result.isError && !result.data ? <SectionError retry={result.refetch} />
      : <>
        {result.isRefetchError && <SectionError retry={result.refetch} />}
        {rows.length ? <MusicRows key={result.dataUpdatedAt} savedOnly viewerId={viewerId} label={t('library.saved_list.label')} rows={rows.map((item) => ({
          content: librarySummary(item), saved: true, available: item.contentType !== 'audioTrack' || item.audioTrack.available
        }))} /> : <div className={styles.empty}>
          <p>{t(query || type ? 'library.empty.filtered_title' : 'library.empty.first_title')}</p>
          <Link to="/search">{t('common.action.explore_music')}</Link>
        </div>}
        {!preview && result.hasNextPage && <div className={styles.loadMore}>
          <button type="button" disabled={result.isFetchingNextPage} onClick={() => result.fetchNextPage()}>{t(result.isFetchingNextPage ? 'common.state.loading_more' : 'common.action.load_more')}</button>
        </div>}
        {result.isFetchNextPageError && <p role="alert">{t('library.error.pagination')}</p>}
      </>}
  </section>;
};

/** The complete bounded history can be searched locally without dropping unloaded results. */
const RecentSection = ({ viewerId, preview }: { viewerId: string; preview: boolean }) => {
  const { t } = useLocalization();
  const result = useQuery(recentlyPlayedQuery(viewerId));
  const [query, setQuery] = useState('');
  useSectionAuthentication(result.error);
  const items = (result.data?.items ?? []).filter((item) => item.content.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <section className={styles.section} aria-labelledby="recent-heading">
    <div className={styles.sectionHeading}><h2 id="recent-heading">{t('library.nav.recent')}</h2>
      {preview && <Link to="?section=recent">{t('library.action.view_all')}</Link>}
    </div>
    <p className={styles.description}>{t('library.recent.description')}</p>
    {!preview && <label className={styles.searchControl}>{t('library.search.recent')}<input type="search" maxLength={100} value={query} onChange={(event) => setQuery(event.target.value)} /></label>}
    {result.isPending ? <p aria-busy="true">{t('library.recent.loading')}</p>
      : result.isError && !result.data ? <SectionError retry={result.refetch} />
      : <>
        {result.isRefetchError && <SectionError retry={result.refetch} />}
        {items.length ? <MusicRows key={result.dataUpdatedAt} viewerId={viewerId} label={t('library.nav.recent')} rows={preview ? items.slice(0, 4) : items} />
          : <p className={styles.empty}>{t(query ? 'library.empty.filtered_title' : 'library.recent.empty')}</p>}
      </>}
  </section>;
};

/** Own playlists remain separate from saved music, including playlists with no members. */
const PlaylistsSection = ({ viewerId, preview }: { viewerId: string; preview: boolean }) => {
  const { t } = useLocalization();
  const [query, setQuery] = useState('');
  const result = useQuery(playlistPageQuery(viewerId, { limit: 100 }));
  useSectionAuthentication(result.error);
  const items = (result.data?.items ?? []).filter((item) => item.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <section className={styles.section} aria-labelledby="playlists-heading">
    <div className={styles.sectionHeading}><h2 id="playlists-heading">{t('library.nav.playlists')}</h2>
      {preview ? <Link to="?section=playlists">{t('library.action.view_all')}</Link> : <Suspense fallback={null}><NewPlaylistButton viewerId={viewerId} className={styles.action} /></Suspense>}
    </div>
    {!preview && <label className={styles.searchControl}>{t('library.search.playlists')}<input type="search" maxLength={100} value={query} onChange={(event) => setQuery(event.target.value)} /></label>}
    {result.isPending ? <p aria-busy="true">{t('playlist.index.loading')}</p>
      : result.isError && !result.data ? <SectionError retry={result.refetch} />
      : <>
        {result.isRefetchError && <SectionError retry={result.refetch} />}
        {items.length ? <Suspense fallback={null}><PlaylistSummaryList playlists={preview ? items.slice(0, 4) : items} viewerId={viewerId} /></Suspense>
          : <div className={styles.empty}><p>{t(query ? 'library.empty.filtered_title' : 'playlist.index.empty_title')}</p>
            {!query && <NewPlaylistButton viewerId={viewerId} className={styles.action} />}</div>}
      </>}
  </section>;
};

/** Library is a personal hub: navigation chooses a source; Save never means history or membership. */
export const LibraryPage = () => {
  const { t } = useLocalization();
  const session = useQuery(browserSessionQuery());
  const capabilities = useQuery(listenerCapabilitiesQuery());
  const [parameters] = useSearchParams();
  const requested = parameters.get('section');
  const section: Section = requested === 'saved' || requested === 'recent' || requested === 'playlists' ? requested : 'overview';
  const viewerId = session.data?.user.id ?? '';
  const preview = section === 'overview';
  return <div className={styles.page}>
    <header className={styles.heading}><div><h1 className={styles.title}>{t('library.title')}</h1><p className={styles.lede}>{t('library.lede')}</p></div>
      {capabilities.data?.playlists && <Suspense fallback={null}><NewPlaylistButton viewerId={viewerId || undefined} accountPending={session.isPending} accountUnavailable={session.isError} className={styles.action} /></Suspense>}
    </header>
    <nav className={styles.sections} aria-label={t('library.nav.label')}>
      <Link aria-current={preview ? 'page' : undefined} to="/library">{t('library.nav.overview')}</Link>
      {capabilities.data?.playlists && <Link aria-current={section === 'playlists' ? 'page' : undefined} to="?section=playlists">{t('library.nav.playlists')}</Link>}
      <Link aria-current={section === 'saved' ? 'page' : undefined} to="?section=saved">{t('library.nav.saved_music')}</Link>
      <Link aria-current={section === 'recent' ? 'page' : undefined} to="?section=recent">{t('library.nav.recent')}</Link>
    </nav>
    {session.isPending ? <p aria-busy="true">{t('library.loading_initial')}</p>
      : session.isError ? <SectionError retry={session.refetch} />
      : !viewerId ? <div className={styles.state}><h2>{t('library.signed_out.title')}</h2><p>{t('library.signed_out.copy')}</p><Link className={styles.loginLink} to="/login" state={{ from: '/library' }}>{t('common.action.log_in')}</Link></div>
      : <div key={viewerId}>
        {(preview || section === 'playlists') && (capabilities.isPending ? <p aria-busy="true">{t('library.loading_initial')}</p>
          : capabilities.isError ? <SectionError retry={capabilities.refetch} />
          : capabilities.data?.playlists ? <Suspense fallback={<p aria-busy="true">{t('playlist.index.loading')}</p>}><PlaylistsSection key={`playlists:${section}`} viewerId={viewerId} preview={preview} /></Suspense>
          : section === 'playlists' ? <p className={styles.empty}>{t('library.playlists.unavailable')}</p> : null)}
        {(preview || section === 'saved') && <SavedSection key={`saved:${section}`} viewerId={viewerId} preview={preview} />}
        {(preview || section === 'recent') && <RecentSection key={`recent:${section}`} viewerId={viewerId} preview={preview} />}
      </div>}
  </div>;
};
