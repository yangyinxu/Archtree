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
import {
  browserSessionQuery,
  browserSessionQueryKey
} from '../../api/session';
import { ContentListRow } from '../../components/ContentListRow';
import { Icon } from '../../components/Icon';
import { SaveButton } from '../../components/SaveButton';
import { launchStandalonePlayback } from '../playback/launchPlayback';
import styles from './LibraryPage.module.css';

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
      streamUrl: item.audioTrack.streamUrl ?? ''
    };

const sortOptions: Array<{ value: LibrarySort; label: string }> = [
  { value: 'recentActivity', label: 'Recent Activity' },
  { value: 'recentlySaved', label: 'Recently Saved' },
  { value: 'recentlyPlayed', label: 'Recently Played' }
];

/** Renders the complete mixed Saved Library with server-side filters and cursor pagination. */
export const LibraryPage = () => {
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
    queryFn: ({ pageParam, signal }) => getLibraryPage({
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
    return <div className={styles.page}><div className={styles.state} aria-busy="true">Gathering your Library…</div></div>;
  }
  if (session.isError) {
    return (
      <div className={styles.page}>
        <div className={styles.state} role="alert">
          <h1>Your Library is out of reach</h1>
          <button onClick={() => session.refetch()} type="button">Try again</button>
        </div>
      </div>
    );
  }
  if (!session.data) {
    return (
      <div className={styles.page}>
        <p className={styles.eyebrow}>Saved for you</p>
        <h1 className={styles.title}>Your Library</h1>
        <div className={styles.state}>
          <span className={styles.stateIcon}><Icon name="lock" /></span>
          <h2>Log in to open your Library</h2>
          <p>Your saved Albums and Soundtracks belong only to your Finitude account.</p>
          <Link className={styles.loginLink} state={{ from: '/library' }} to="/login">Log in</Link>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.heading}>
        <div>
          <p className={styles.eyebrow}>Saved for you</p>
          <h1 className={styles.title}>Your Library</h1>
          <p className={styles.lede}>Every Album and Soundtrack you save, without a twenty-item cap.</p>
        </div>
        <label className={styles.sortControl}>
          <span>Sort</span>
          <select onChange={(event) => setSort(event.currentTarget.value as LibrarySort)} value={sort}>
            {sortOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
      </div>

      <div className={styles.filters} aria-label="Library content filters" role="group">
        <button aria-pressed={selectedTypes.includes('album')} onClick={() => toggleType('album')} type="button">Albums</button>
        <button aria-pressed={selectedTypes.includes('audioTrack')} onClick={() => toggleType('audioTrack')} type="button">Songs</button>
      </div>

      {library.isPending ? (
        <div className={styles.state} aria-busy="true">Loading saved music…</div>
      ) : library.isError ? (
        <div className={styles.state} role="alert">
          <h2>{library.error instanceof ApiError && library.error.status === 401 ? 'Log in to continue' : 'Your Library could not be loaded'}</h2>
          <button onClick={() => library.refetch()} type="button">Try again</button>
        </div>
      ) : items.length === 0 ? (
        <div className={styles.state}>
          <h2>{selectedTypes.length > 0 ? 'Nothing matches these filters' : 'Your Library is ready for its first save'}</h2>
          <p>{selectedTypes.length > 0 ? 'Choose another content filter.' : 'Save an Album or Soundtrack and it will appear here.'}</p>
          {selectedTypes.length === 0 && <Link className={styles.loginLink} to="/search">Explore music</Link>}
        </div>
      ) : (
        <>
          <ul className={styles.list} aria-label="Saved Albums and Soundtracks">
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
                      {!playable && <span className={styles.unavailable}>Unavailable</span>}
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
                {library.isFetchingNextPage ? 'Loading more…' : 'Load more'}
              </button>
            </div>
          )}
          {library.isFetchNextPageError && <p className={styles.paginationError} role="alert">More saved music could not be loaded. Try Load more again.</p>}
        </>
      )}
    </div>
  );
};
