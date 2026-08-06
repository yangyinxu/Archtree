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

/** Renders the complete owner-scoped Playlist index at every responsive size. */
export const PlaylistIndexPage = () => {
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
          <p className={styles.eyebrow}>Your Library</p>
          <h1>Playlists</h1>
          <p className={styles.lede}>Private, ordered listening lists that follow your account.</p>
        </div>
        <NewPlaylistButton
          accountPending={session.isPending}
          accountUnavailable={session.isError}
          className={styles.primaryButton}
          viewerId={viewerId || undefined}
        />
      </header>

      {session.isPending ? (
        <div aria-busy="true" className={styles.state}>Checking your account…</div>
      ) : session.isError ? (
        <div className={styles.state} role="alert">
          <ListMusic aria-hidden="true" />
          <h2>Your Playlists are out of reach</h2>
          <p>Finitude could not safely confirm your account.</p>
          <button className={styles.secondaryButton} onClick={() => session.refetch()} type="button">Try again</button>
        </div>
      ) : !session.data ? (
        <div className={styles.state}>
          <ListMusic aria-hidden="true" />
          <h2>Log in to open your Playlists</h2>
          <p>Only you can see and change the Playlists in your Finitude account.</p>
          <Link className={styles.primaryButton} state={{ from: '/playlists' }} to="/login">Log in</Link>
        </div>
      ) : playlists.isPending ? (
        <div aria-busy="true" className={styles.state}>Loading your Playlists…</div>
      ) : playlists.isError ? (
        <div className={styles.state} role="alert">
          <h2>Your Playlists could not be loaded</h2>
          <p>{playlists.error instanceof ApiError ? playlists.error.message : 'Try again in a moment.'}</p>
          <button className={styles.secondaryButton} onClick={() => playlists.refetch()} type="button">Try again</button>
        </div>
      ) : playlists.data.items.length === 0 ? (
        <div className={styles.state}>
          <ListMusic aria-hidden="true" />
          <h2>Make room for a new sequence</h2>
          <p>Create your first Playlist, then add ready Soundtracks in the order you want to hear them.</p>
          <NewPlaylistButton className={styles.primaryButton} viewerId={viewerId} />
        </div>
      ) : (
        <PlaylistSummaryList playlists={playlists.data.items} viewerId={viewerId} />
      )}
    </div>
  );
};

export default PlaylistIndexPage;
