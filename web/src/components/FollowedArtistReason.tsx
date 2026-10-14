import { Link } from 'react-router';
import type { FollowedArtistReason as Reason } from '../api/contentSchemas';
import { useLocalization } from '../localization/LocalizationProvider';
import styles from './FollowedArtistReason.module.css';

/** Keeps the complete localized explanation outside the item's playback/navigation action. */
export const FollowedArtistReason = ({ reason }: { reason?: Reason }) => {
  const { t } = useLocalization();
  return reason ? <Link className={styles.reason} to={`/artists/${encodeURIComponent(reason.artist.id)}`}>
    {t('home.followed_artist_release_reason', { artist: reason.artist.name })}
  </Link> : null;
};
