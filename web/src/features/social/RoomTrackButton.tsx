import { lazy, Suspense, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocalization } from '../../localization/LocalizationProvider';
import styles from '../../components/SaveButton.module.css';

const RoomTrackDialog = lazy(() => import('./RoomTrackDialog'));
export interface RoomTrackButtonProps { mediaTrackId: string; title: string; compact?: boolean }

/** Opening a room action never invokes the content's playback or ordinary private queue actions. */
export default function RoomTrackButton({ compact = true, ...track }: RoomTrackButtonProps) {
  const { t } = useLocalization();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return <span className={`${styles.wrapper} ${compact ? styles.compact : ''}`}>
    <button type="button" className={styles.button} aria-label={t('room_track.title', { title: track.title })}
      title={t('room_track.action')} ref={trigger} onClick={() => setOpen(true)}><span aria-hidden="true">♫</span>{!compact && t('room_track.action')}</button>
    {open && createPortal(<Suspense fallback={null}><RoomTrackDialog key={track.mediaTrackId} {...track} onClose={() => setOpen(false)} returnFocusRef={trigger} /></Suspense>, document.body)}
  </span>;
}
