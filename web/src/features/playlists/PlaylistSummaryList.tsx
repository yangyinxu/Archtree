import { NavLink } from 'react-router';

import type { PlaylistSummary } from '../../api/playlists';
import { Artwork } from '../../components/Artwork';
import { PlaylistSummaryActions } from './PlaylistControls';
import styles from './Playlists.module.css';

/** Shares owner summary rows while allowing the sidebar to use a compact presentation. */
export const PlaylistSummaryList = ({
  playlists,
  viewerId,
  compact = false
}: {
  playlists: PlaylistSummary[];
  viewerId: string;
  compact?: boolean;
}) => (
  <ul className={compact ? styles.sidebarList : styles.summaryList} aria-label="Your Playlists">
    {playlists.map((playlist) => (
      <li className={compact ? styles.sidebarListItem : styles.summaryListItem} key={playlist.id}>
        <NavLink
          aria-label={`${playlist.name}, ${playlist.itemCount} soundtrack${playlist.itemCount === 1 ? '' : 's'}`}
          className={({ isActive }) => `${compact ? styles.sidebarPlaylistLink : styles.summaryLink} ${isActive ? styles.activePlaylist : ''}`}
          title={playlist.name}
          to={`/playlists/${encodeURIComponent(playlist.id)}`}
        >
          <Artwork
            alt=""
            className={styles.summaryArtwork}
            kind="audioTrack"
            sizes={compact ? '2.75rem' : '3.25rem'}
            src={playlist.artworkUrl}
          />
          <span className={styles.summaryCopy}>
            <span className={styles.summaryName}>{playlist.name}</span>
            <span className={styles.summaryMetadata}>
              Playlist · {playlist.itemCount} soundtrack{playlist.itemCount === 1 ? '' : 's'}
            </span>
          </span>
        </NavLink>
        <PlaylistSummaryActions playlist={playlist} viewerId={viewerId} />
      </li>
    ))}
  </ul>
);
