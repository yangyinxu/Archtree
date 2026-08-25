import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { ListMusic } from 'lucide-react';

import { ApiError } from '../../api/client';
import { playlistPageQuery } from '../../api/playlists';
import { browserSessionQuery, browserSessionQueryKey } from '../../api/session';
import { NewPlaylistButton } from './PlaylistControls';
import { PlaylistSummaryList } from './PlaylistSummaryList';
import styles from './Playlists.module.css';
import { useLocalization } from '../../localization/LocalizationProvider';

/** Renders the complete owner-scoped Playlist index at every responsive size. */
export const PlaylistIndexPage = () => {
  const { t } = useLocalization();
  const queryClient = useQueryClient();
  const session = useQuery(browserSessionQuery());
  const viewerId = session.data?.user.id ?? '';
  const playlists = useQuery(playlistPageQuery(viewerId, { limit: 100 }));

  useEffect(() => {
    if (playlists.error instanceof ApiError && playlists.error.status === 401) {
      queryClient.setQueryData(browserSessionQueryKey, null);
    }
  }, [playlists.error, queryClient]);

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <div>
          <p className={styles.eyebrow}>{t('library.title')}</p>
          <h1>{t('playlist.index.title')}</h1>
          <p className={styles.lede}>{t('playlist.index.lede')}</p>
        </div>
        <NewPlaylistButton
          accountPending={session.isPending}
          accountUnavailable={session.isError}
          className={styles.primaryButton}
          viewerId={viewerId || undefined}
        />
      </header>

      {session.isPending ? (
        <div aria-busy="true" className={styles.state}>{t('playlist.index.checking_account')}</div>
      ) : session.isError ? (
        <div className={styles.state} role="alert">
          <ListMusic aria-hidden="true" />
          <h2>{t('playlist.index.account_error_title')}</h2>
          <p>{t('playlist.index.account_error_copy')}</p>
          <button className={styles.secondaryButton} onClick={() => session.refetch()} type="button">{t('common.action.try_again')}</button>
        </div>
      ) : !session.data ? (
        <div className={styles.state}>
          <ListMusic aria-hidden="true" />
          <h2>{t('playlist.index.signed_out_title')}</h2>
          <p>{t('playlist.index.signed_out_copy')}</p>
          <Link className={styles.primaryButton} state={{ from: '/playlists' }} to="/login">{t('common.action.log_in')}</Link>
        </div>
      ) : playlists.isPending ? (
        <div aria-busy="true" className={styles.state}>{t('playlist.index.loading')}</div>
      ) : playlists.isError ? (
        <div className={styles.state} role="alert">
          <h2>{t('playlist.index.load_error')}</h2>
          <p>{t('playlist.error.try_moment')}</p>
          <button className={styles.secondaryButton} onClick={() => playlists.refetch()} type="button">{t('common.action.try_again')}</button>
        </div>
      ) : playlists.data.items.length === 0 ? (
        <div className={styles.state}>
          <ListMusic aria-hidden="true" />
          <h2>{t('playlist.index.empty_title')}</h2>
          <p>{t('playlist.index.empty_copy')}</p>
          <NewPlaylistButton className={styles.primaryButton} viewerId={viewerId} />
        </div>
      ) : (
        <PlaylistSummaryList playlists={playlists.data.items} viewerId={viewerId} />
      )}
    </div>
  );
};

export default PlaylistIndexPage;
