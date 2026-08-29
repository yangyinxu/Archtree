import { useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';

import { ApiError } from '../../api/client';
import type {
  ContentSummary,
  LibraryContentType,
  LibraryItem,
  LibrarySort,
  LibraryTarget
} from '../../api/contentSchemas';
import {
  getLibraryPage,
  listenerQueryKeys,
  type LibraryPageOptions
} from '../../api/listener';
import { listenerCapabilitiesQuery } from '../../api/listenerCapabilities';
import {
  browserSessionQuery,
  browserSessionQueryKey
} from '../../api/session';
import { ContentListRow } from '../../components/ContentListRow';
import { Icon } from '../../components/Icon';
import { SaveButton } from '../../components/SaveButton';
import { launchStandalonePlayback } from '../playback/launchPlayback';
import { LazyAddTrackToPlaylistButton } from '../playlists/LazyAddTrackToPlaylistButton';
import styles from './LibraryPage.module.css';
import { useLocalization } from '../../localization/LocalizationProvider';
import type { MessageKey } from '../../localization/contract';

const librarySummary = (item: LibraryItem): ContentSummary => item.contentType === 'album'
  ? {
      contentType: 'album',
      id: item.contentId,
      title: item.album.title,
      artworkUrl: item.album.coverArtUrl,
      artistNames: item.creator ? [item.creator] : [],
      releaseDate: item.album.releaseDate
    }
  : {
      contentType: 'audioTrack',
      id: item.contentId,
      title: item.audioTrack.title,
      artworkUrl: item.audioTrack.displayCoverArtUrl || item.audioTrack.coverArtUrl,
      artistNames: item.creator ? [item.creator] : [],
      albumId: item.audioTrack.albumId,
      albumTitle: null,
      duration: item.audioTrack.duration,
      mediaType: item.audioTrack.mediaType,
      streamUrl: item.audioTrack.streamUrl ?? ''
    };

const sortOptions: Array<{ value: LibrarySort; labelKey: MessageKey }> = [
  { value: 'recentActivity', labelKey: 'library.sort.recent_activity' },
  { value: 'recentlySaved', labelKey: 'library.sort.recently_saved' },
  { value: 'recentlyPlayed', labelKey: 'library.sort.recently_played' }
];

/** Keeps Playlists reachable from the Library-owned mobile and tablet hierarchy. */
const LibrarySections = () => (
  <LibrarySectionsContent />
);

const LibrarySectionsContent = () => {
  const capabilities = useQuery(listenerCapabilitiesQuery());
  const { t } = useLocalization();
  return (
    <nav aria-label={t('library.nav.label')} className={styles.sections}>
      <span aria-current="page">{t('library.nav.saved_music')}</span>
      {capabilities.data?.playlists && <Link to="/playlists">{t('common.label.playlists')}</Link>}
    </nav>
  );
};

/** Renders the complete mixed Saved Library with server-side filters and cursor pagination. */
export const LibraryPage = () => {
  const { t } = useLocalization();
  const session = useQuery(browserSessionQuery());
  const viewerId = session.data?.user.id ?? '';
  const queryClient = useQueryClient();
  const [selectedTypes, setSelectedTypes] = useState<LibraryContentType[]>([]);
  const [sort, setSort] = useState<LibrarySort>('recentActivity');
  const [removedKeys, setRemovedKeys] = useState<Set<string>>(() => new Set());
  const options = useMemo<LibraryPageOptions>(() => ({
    contentTypes: selectedTypes,
    sort,
    limit: 30
  }), [selectedTypes, sort]);
  const library = useInfiniteQuery({
    queryKey: listenerQueryKeys.library(viewerId, options),
    queryFn: ({ pageParam, signal }) => getLibraryPage(viewerId, {
      ...options,
      cursor: typeof pageParam === 'string' ? pageParam : undefined
    }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: Boolean(viewerId)
  });

  useEffect(() => setRemovedKeys(new Set()), [selectedTypes, sort, viewerId]);
  useEffect(() => {
    if (library.error instanceof ApiError && library.error.status === 401) {
      queryClient.setQueryData(browserSessionQueryKey, null);
    }
  }, [library.error, queryClient]);

  const items = useMemo(() => {
    const byKey = new Map<string, LibraryItem>();
    for (const page of library.data?.pages ?? []) {
      for (const item of page.items) {
        const key = `${item.contentType}:${item.contentId}`;
        if (!removedKeys.has(key)) byKey.set(key, item);
      }
    }
    return [...byKey.values()];
  }, [library.data, removedKeys]);

  const toggleType = (contentType: LibraryContentType) => {
    setSelectedTypes((current) => current.includes(contentType)
      ? current.filter((value) => value !== contentType)
      : [...current, contentType]);
  };

  if (session.isPending) {
    return <div className={styles.page}><LibrarySections /><div className={styles.state} aria-busy="true">{t('library.loading_initial')}</div></div>;
  }
  if (session.isError) {
    return (
      <div className={styles.page}>
        <LibrarySections />
        <div className={styles.state} role="alert">
          <h1>{t('library.error.session')}</h1>
          <button onClick={() => session.refetch()} type="button">{t('common.action.try_again')}</button>
        </div>
      </div>
    );
  }
  if (!session.data) {
    return (
      <div className={styles.page}>
        <LibrarySections />
        <p className={styles.eyebrow}>{t('library.subtitle')}</p>
        <h1 className={styles.title}>{t('library.title')}</h1>
        <div className={styles.state}>
          <span className={styles.stateIcon}><Icon name="lock" /></span>
          <h2>{t('library.signed_out.title')}</h2>
          <p>{t('library.signed_out.copy')}</p>
          <Link className={styles.loginLink} state={{ from: '/library' }} to="/login">{t('common.action.log_in')}</Link>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <LibrarySections />
      <div className={styles.heading}>
        <div>
          <p className={styles.eyebrow}>{t('library.subtitle')}</p>
          <h1 className={styles.title}>{t('library.title')}</h1>
          <p className={styles.lede}>{t('library.lede')}</p>
        </div>
        <label className={styles.sortControl}>
          <span>{t('library.sort.label')}</span>
          <select onChange={(event) => setSort(event.currentTarget.value as LibrarySort)} value={sort}>
            {sortOptions.map((option) => <option key={option.value} value={option.value}>{t(option.labelKey)}</option>)}
          </select>
        </label>
      </div>

      <div className={styles.filters} aria-label={t('library.filters.label')} role="group">
        <button aria-pressed={selectedTypes.includes('album')} onClick={() => toggleType('album')} type="button">{t('common.label.albums')}</button>
        <button aria-pressed={selectedTypes.includes('audioTrack')} onClick={() => toggleType('audioTrack')} type="button">{t('common.label.songs')}</button>
      </div>

      {library.isPending ? (
        <div className={styles.state} aria-busy="true">{t('library.loading')}</div>
      ) : library.isError ? (
        <div className={styles.state} role="alert">
          <h2>{library.error instanceof ApiError && library.error.status === 401
            ? t('library.error.auth_required')
            : t('library.error.load')}</h2>
          <button onClick={() => library.refetch()} type="button">{t('common.action.try_again')}</button>
        </div>
      ) : items.length === 0 ? (
        <div className={styles.state}>
          <h2>{selectedTypes.length > 0
            ? t('library.empty.filtered_title')
            : t('library.empty.first_title')}</h2>
          <p>{selectedTypes.length > 0
            ? t('library.empty.filtered_copy')
            : t('library.empty.first_copy')}</p>
          {selectedTypes.length === 0 && <Link className={styles.loginLink} to="/search">{t('common.action.explore_music')}</Link>}
        </div>
      ) : (
        <>
          <ul className={styles.list} aria-label={t('library.saved_list.label')}>
            {items.map((item) => {
              const summary = librarySummary(item);
              const playable = item.contentType !== 'audioTrack' || item.audioTrack.available;
              const target: LibraryTarget = { contentType: item.contentType, contentId: item.contentId };
              const key = `${item.contentType}:${item.contentId}`;
              return (
                <ContentListRow
                  item={summary}
                  key={key}
                  onPlay={summary.contentType === 'audioTrack' && playable
                    ? (track) => { void launchStandalonePlayback(track, viewerId); }
                    : undefined}
                  trailing={(
                    <span className={styles.rowActions}>
                      {!playable && <span className={styles.unavailable}>{t('common.state.unavailable')}</span>}
                      {summary.contentType === 'audioTrack' && playable && (
                        <LazyAddTrackToPlaylistButton track={summary} viewerId={viewerId} />
                      )}
                      <SaveButton
                        compact
                        onSavedChange={(saved) => {
                          if (!saved) setRemovedKeys((current) => new Set(current).add(key));
                        }}
                        saved
                        target={target}
                        viewerId={viewerId}
                      />
                    </span>
                  )}
                />
              );
            })}
          </ul>
          {library.hasNextPage && (
            <div className={styles.loadMore}>
              <button disabled={library.isFetchingNextPage} onClick={() => library.fetchNextPage()} type="button">
                {library.isFetchingNextPage ? t('common.state.loading_more') : t('common.action.load_more')}
              </button>
            </div>
          )}
          {library.isFetchNextPageError && <p className={styles.paginationError} role="alert">{t('library.error.pagination')}</p>}
        </>
      )}
    </div>
  );
};
