import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useLocalization } from '../../localization/LocalizationProvider';
import { musicShareSession, useMusicShareSession } from './musicShareSession';
import styles from './SocialPage.module.css';

/** All share surfaces retain the same account-owned operation, including after a modal closes. */
export const useShareActions = (viewerId: string) => {
  const client = useQueryClient();
  const state = useMusicShareSession();
  useEffect(() => { musicShareSession.ensure(viewerId, () => client.invalidateQueries({ queryKey: ['social', viewerId] })); }, [viewerId, client]);
  return { ...state, ready: state.viewerId === viewerId };
};

export const MusicShareRecovery = ({ viewerId }: { viewerId: string }) => {
  const { t } = useLocalization();
  const state = useMusicShareSession();
  if (state.viewerId !== viewerId || !state.message && !state.uncertain) return null;
  return <div className={state.uncertain ? styles.error : styles.status} role="status">
    {t(state.message ?? 'social.unknown')}
    {state.uncertain && <div className={styles.actions}>
      <button className={styles.secondary} disabled={state.busy} onClick={() => musicShareSession.check()}>{t('social.check_outcome')}</button>
      <button className={styles.secondary} disabled={state.busy} onClick={() => musicShareSession.retry()}>{t('social.retry_same')}</button>
    </div>}
  </div>;
};
