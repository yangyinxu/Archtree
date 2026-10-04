import { useLocalization } from '../../localization/LocalizationProvider';
import { listeningSession, useListeningSession } from './listeningSession';
import styles from './SocialPage.module.css';

/** Preference receipts survive route changes; stopping locally never claims an unknown durable opt-out succeeded. */
export const ListeningSharingSettings = ({ viewerId }: { viewerId: string }) => {
  const { t } = useLocalization();
  const state = useListeningSession();
  const current = state.viewerId === viewerId, own = current ? state.own : null;
  return <section className={styles.panel} aria-label={t('listening.sharing')}>
    <h2>{t('listening.sharing')}</h2><p className={styles.muted}>{t('listening.hint')}</p>
    {!own && !state.error && <p role="status">{t('social.loading')}</p>}
    {current && state.error && <p className={styles.error} role="status">{t(state.error)}</p>}
    {own && <><p className={styles.muted}>{t(state.owned ? state.publishing ? 'listening.owned' : 'listening.idle' : 'listening.other_device')}</p>
      <div className={styles.actions}>
        <button className={styles.secondary} disabled={state.busy || !own.enabled && Boolean(state.uncertain)} onClick={() => listeningSession.setEnabled(!own.enabled)}>{t(own.enabled ? 'listening.disable' : 'listening.enable')}</button>
        {own.enabled && <button className={styles.button} disabled={state.busy || Boolean(state.uncertain && state.uncertain.action !== 'claimListening')} onClick={() => listeningSession.useDevice()}>{t('listening.claim')}</button>}
      </div></>}
    {current && state.uncertain && <div className={styles.actions}>
      <button className={styles.secondary} disabled={state.busy} onClick={() => listeningSession.check()}>{t('social.check_outcome')}</button>
      <button className={styles.secondary} disabled={state.busy} onClick={() => listeningSession.retry()}>{t('social.retry_same')}</button>
    </div>}
    {current && state.error && <div className={styles.actions}><button className={styles.secondary} disabled={state.busy} onClick={() => listeningSession.refresh()}>{t('social.refresh')}</button></div>}
  </section>;
};
