import { useQuery } from '@tanstack/react-query';
import { ListMusic } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';

import { listenerCapabilitiesQuery } from '../../api/listenerCapabilities';
import styles from './Playlists.module.css';

/** Prevents a disabled rollout from rendering private queries or dead controls. */
export const PlaylistFeatureGate = ({ children }: { children: ReactNode }) => {
  const capabilities = useQuery(listenerCapabilitiesQuery());

  if (capabilities.isPending) {
    return <div className={styles.page}><div aria-busy="true" className={styles.state}>Checking Playlist availability…</div></div>;
  }
  if (capabilities.isError) {
    return (
      <div className={styles.page}><div className={styles.state} role="alert">
        <ListMusic aria-hidden="true" />
        <h1>Playlist availability could not be checked</h1>
        <p>Try again before opening private Playlist data.</p>
        <button className={styles.secondaryButton} onClick={() => capabilities.refetch()} type="button">Try again</button>
      </div></div>
    );
  }
  if (!capabilities.data.playlists) {
    return (
      <div className={styles.page}><div className={styles.state}>
        <ListMusic aria-hidden="true" />
        <h1>Playlists are not available yet</h1>
        <p>Your saved music and listening history are unchanged.</p>
        <Link className={styles.secondaryButton} to="/library">Back to Library</Link>
      </div></div>
    );
  }
  return children;
};

export default PlaylistFeatureGate;
