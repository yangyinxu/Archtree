import { useEffect, useRef, useState } from 'react';
import { captureAccountOperation, isAccountOperationCurrent } from '../../api/accountEpoch';
import { useLocalization } from '../../localization/LocalizationProvider';
import styles from './SocialPage.module.css';

/** Copies a recipient-bound pointer, never a room admission token or an automatically renewed invitation. */
export const CopyInvitationLink = ({ viewerId, invitationId, alias, disabled }: {
  viewerId: string; invitationId: string; alias: string; disabled: boolean;
}) => {
  const { t } = useLocalization();
  const alive = useRef(true);
  const [result, setResult] = useState<'copied' | 'manual' | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const link = new URL(`/finitude/social/invitations/${encodeURIComponent(invitationId)}`, window.location.origin).href;
  const copy = async () => {
    const guard = captureAccountOperation(viewerId);
    let outcome: 'copied' | 'manual' = 'copied';
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(link);
    } catch { outcome = 'manual'; }
    if (alive.current && isAccountOperationCurrent(guard)) setResult(outcome);
  };
  return <div className={styles.invitationCopy}>
    <button className={styles.secondary} disabled={disabled} onClick={() => void copy()}>{t('room.invitation_copy')}</button>
    {result && <div>
      <p role="status" className={styles.muted}>{t(result === 'copied' ? 'room.invitation_copied' : 'room.invitation_copy_manual')}</p>
      <label className={styles.field}>{t('room.invitation_link')}<input readOnly value={link} onFocus={event => event.target.select()} /></label>
      <p className={styles.muted}>{t('room.invitation_recipient_only', { alias })}</p>
    </div>}
  </div>;
};
