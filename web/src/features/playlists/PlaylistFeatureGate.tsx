import { useQuery } from '@tanstack/react-query';
import { ListMusic } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';

import { listenerCapabilitiesQuery } from '../../api/listenerCapabilities';
import styles from './Playlists.module.css';
import { useLocalization } from '../../localization/LocalizationProvider';

/** Prevents a disabled rollout from rendering private queries or dead controls. */
export const PlaylistFeatureGate = ({ children }: { children: ReactNode }) => {
  const capabilities = useQuery(listenerCapabilitiesQuery());
  const { t } = useLocalization();

  if (capabilities.isPending) {
    return <div className={styles.page}><div aria-busy="true" className={styles.state}>{t('playlist.feature.checking')}</div></div>;
  }
  if (capabilities.isError) {
    return (
      <div className={styles.page}><div className={styles.state} role="alert">
        <ListMusic aria-hidden="true" />
        <h1>{t('playlist.feature.error_title')}</h1>
        <p>{t('playlist.feature.error_copy')}</p>
        <button className={styles.secondaryButton} onClick={() => capabilities.refetch()} type="button">{t('common.action.try_again')}</button>
      </div></div>
    );
  }
  if (!capabilities.data.playlists) {
    return (
      <div className={styles.page}><div className={styles.state}>
        <ListMusic aria-hidden="true" />
        <h1>{t('playlist.feature.unavailable_title')}</h1>
        <p>{t('playlist.feature.unavailable_copy')}</p>
        <Link className={styles.secondaryButton} to="/library">{t('playlist.action.back_library')}</Link>
      </div></div>
    );
  }
  return children;
};

export default PlaylistFeatureGate;
