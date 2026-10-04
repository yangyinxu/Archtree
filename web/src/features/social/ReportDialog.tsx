import { useRef, useState, type RefObject } from 'react';
import type { SocialAction, SocialReportReason } from '../../api/social';
import { ModalDialog } from '../../components/ModalDialog';
import { useLocalization } from '../../localization/LocalizationProvider';
import styles from './SocialPage.module.css';

const reasons: SocialReportReason[] = ['impersonation', 'harassment', 'spam', 'inappropriate', 'other'];
export interface ReportTarget { socialId: string; label: string }

/**
 * Confirms one explicit report. Sending is the only submit path, the dialog closes once the
 * command settles, and the page's shared status area shows the outcome or recovery controls.
 */
export default function ReportDialog({ target, busy, run, onClose, returnFocusRef }: {
  target: ReportTarget; busy: boolean; run: (action: SocialAction) => Promise<void>;
  onClose: () => void; returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const { t } = useLocalization();
  const first = useRef<HTMLInputElement>(null);
  const [reason, setReason] = useState<SocialReportReason | ''>('');
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  return <ModalDialog title={t('social.report_title')} kicker={target.label} description={t('social.report_hint')}
    initialFocusRef={first} returnFocusRef={returnFocusRef} onClose={onClose} closeDisabled={sending}>
    <form className={styles.stack} onSubmit={event => {
      event.preventDefault();
      if (!reason || busy || sending) return;
      setSending(true);
      void run({ action: 'report', targetSocialId: target.socialId, reason, ...(note.trim() ? { note: note.trim() } : {}) }).finally(onClose);
    }}>
      <fieldset className={styles.reasons}><legend>{t('social.report_reason')}</legend>
        {reasons.map((value, index) => <label className={styles.check} key={value}>
          <input type="radio" name="report-reason" value={value} required ref={index === 0 ? first : undefined}
            checked={reason === value} onChange={() => setReason(value)} />{t(`social.report_reason_${value}`)}</label>)}
      </fieldset>
      <label className={styles.field}>{t('social.report_note')}<textarea rows={3} maxLength={500} value={note} onChange={event => setNote(event.target.value)} /></label>
      <div className={styles.actions}>
        <button className={styles.danger} disabled={!reason || busy || sending}>{t('social.report_send')}</button>
        <button className={styles.secondary} type="button" disabled={sending} onClick={onClose}>{t('common.action.cancel')}</button>
      </div>
    </form>
  </ModalDialog>;
}
