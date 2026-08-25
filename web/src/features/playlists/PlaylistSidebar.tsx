import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';

import { ApiError } from '../../api/client';
import { playlistPageQuery } from '../../api/playlists';
import { browserSessionQuery, browserSessionQueryKey } from '../../api/session';
import { NewPlaylistButton } from './PlaylistControls';
import { PlaylistSummaryList } from './PlaylistSummaryList';
import styles from './Playlists.module.css';
import { useLocalization } from '../../localization/LocalizationProvider';

/** Adds summary-only owner discovery without hydrating members into the shell. */
export const PlaylistSidebar = () => {
  const { t } = useLocalization();
  const queryClient = useQueryClient();
  const session = useQuery(browserSessionQuery());
  const viewerId = session.data?.user.id ?? '';
  const playlists = useQuery(playlistPageQuery(viewerId, { limit: 50 }));

  useEffect(() => {
    if (playlists.error instanceof ApiError && playlists.error.status === 401) {
      queryClient.setQueryData(browserSessionQueryKey, null);
    }
  }, [playlists.error, queryClient]);

  return (
    <section className={styles.sidebarSection} aria-label={t('playlist.index.title')}>
      <NewPlaylistButton
        accountPending={session.isPending}
        accountUnavailable={session.isError}
        className={styles.sidebarCreate}
        viewerId={viewerId || undefined}
      />
      {viewerId && (
        <div className={styles.sidebarCollection}>
          <div className={styles.sidebarHeading}>
            <span>{t('playlist.sidebar.heading')}</span>
            <Link to="/playlists">{t('playlist.action.view_all')}</Link>
          </div>
          {playlists.isPending ? (
            <p aria-busy="true" className={styles.sidebarState}>{t('playlist.sidebar.loading')}</p>
          ) : playlists.isError ? (
            <div className={styles.sidebarState} role="alert">
              <span>{t('playlist.sidebar.unavailable')}</span>
              <button onClick={() => playlists.refetch()} type="button">{t('common.action.retry')}</button>
            </div>
          ) : playlists.data.items.length === 0 ? (
            <p className={styles.sidebarState}>{t('playlist.sidebar.empty')}</p>
          ) : (
            <>
              <PlaylistSummaryList compact playlists={playlists.data.items} viewerId={viewerId} />
              {playlists.data.nextCursor && <Link className={styles.sidebarViewAll} to="/playlists">{t('playlist.action.view_all')} {t('playlist.index.title')}</Link>}
            </>
          )}
        </div>
      )}
    </section>
  );
};

export default PlaylistSidebar;
