import { NavLink } from 'react-router';

import type { PlaylistSummary } from '../../api/playlists';
import { Artwork } from '../../components/Artwork';
import { PlaylistSummaryActions } from './PlaylistControls';
import styles from './Playlists.module.css';
import { useLocalization } from '../../localization/LocalizationProvider';

/** Shares owner summary rows while allowing the sidebar to use a compact presentation. */
export const PlaylistSummaryList = ({
  playlists,
  viewerId,
  compact = false
}: {
  playlists: PlaylistSummary[];
  viewerId: string;
  compact?: boolean;
}) => {
  const { t } = useLocalization();
  return (
  <ul className={compact ? styles.sidebarList : styles.summaryList} aria-label={t('playlist.sidebar.heading')}>
    {playlists.map((playlist) => (
      <li className={compact ? styles.sidebarListItem : styles.summaryListItem} key={playlist.id}>
        <NavLink
          aria-label={t('playlist.summary.label', {
            name: playlist.name,
            count: playlist.itemCount
          })}
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
              {t('common.label.playlist')} · {t('playlist.item_count', { count: playlist.itemCount })}
            </span>
          </span>
        </NavLink>
        <PlaylistSummaryActions playlist={playlist} viewerId={viewerId} />
      </li>
    ))}
  </ul>
  );
};
