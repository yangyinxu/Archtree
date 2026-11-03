import { useRef, useState, useSyncExternalStore } from 'react';
import { Settings2 } from 'lucide-react';

import { ModalDialog } from '../../components/ModalDialog';
import { formatLocalizedMessage, useLocalization } from '../../localization/LocalizationProvider';
import { readVideoPreviewMuted, setVideoPreviewMuted, subscribeVideoPreviewPreferences } from './videoPreviewPreferences';
import { videoTextFor } from './videoText';
import styles from '../../styles/Pages.module.css';

/** Anonymous listeners can change a device-local default without changing an active preview. */
export default function VideoPreviewSettings() {
  const { locale, t } = useLocalization();
  const text = videoTextFor(locale, formatLocalizedMessage);
  const [open, setOpen] = useState(false);
  const muted = useSyncExternalStore(subscribeVideoPreviewPreferences, readVideoPreviewMuted, () => false);
  const trigger = useRef<HTMLButtonElement>(null);
  const checkbox = useRef<HTMLInputElement>(null);
  const title = text('videos.settings.title');
  return <>
    <button aria-label={title} aria-haspopup="dialog" aria-expanded={open} title={title}
      className={`${styles.button} ${styles.buttonSecondary}`} onClick={() => setOpen(true)} ref={trigger}
      style={{ padding: '.55rem', minWidth: '2.5rem' }} type="button">
      <Settings2 aria-hidden="true" size={18} />
    </button>
    {open && <ModalDialog description={text('videos.settings.help')} initialFocusRef={checkbox}
      onClose={() => setOpen(false)} returnFocusRef={trigger} title={title}>
      <label style={{ display: 'flex', alignItems: 'center', gap: '.75rem', lineHeight: 1.5 }}>
        <input checked={muted} onChange={event => setVideoPreviewMuted(event.currentTarget.checked)}
          ref={checkbox} style={{ accentColor: 'var(--color-accent)', width: '1.15rem', height: '1.15rem' }} type="checkbox" />
        <span>{text('videos.settings.mute')}</span>
      </label>
      <div className={styles.actions} style={{ marginTop: '1.5rem' }}>
        <button className={`${styles.button} ${styles.buttonSecondary}`} onClick={() => setOpen(false)} type="button">
          {t('common.action.close')}
        </button>
      </div>
    </ModalDialog>}
  </>;
}
