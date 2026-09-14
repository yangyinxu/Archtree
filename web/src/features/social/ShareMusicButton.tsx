import { lazy, Suspense, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SharedMusicType } from '../../api/musicShares';
import { useLocalization } from '../../localization/LocalizationProvider';
import styles from '../../components/SaveButton.module.css';

const ShareMusicDialog = lazy(() => import('./ShareMusicDialog'));
export interface ShareMusicButtonProps { contentType: SharedMusicType; contentId: string; title: string; compact?: boolean }

/** Opens a separate explicit share gesture without triggering the content's primary playback action. */
export default function ShareMusicButton({ compact = true, ...music }: ShareMusicButtonProps) {
  const { t } = useLocalization();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return <span className={`${styles.wrapper} ${compact ? styles.compact : ''}`}>
    <button type="button" className={styles.button} aria-label={t('music_shares.share_title', { title: music.title })}
      title={t('music_shares.share')} ref={trigger} onClick={() => setOpen(true)}><span aria-hidden="true">↗</span>{!compact && t('music_shares.share')}</button>
    {open && createPortal(<Suspense fallback={null}><ShareMusicDialog {...music} onClose={() => setOpen(false)} returnFocusRef={trigger} /></Suspense>, document.body)}
  </span>;
}
