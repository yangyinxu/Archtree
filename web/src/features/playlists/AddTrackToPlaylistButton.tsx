import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ListPlus } from 'lucide-react';

import type { AudioTrackSummary } from '../../api/contentSchemas';
import { listenerCapabilitiesQuery } from '../../api/listenerCapabilities';
import { ModalDialog } from '../../components/ModalDialog';
import { SignedOutPlaylistDialog } from './SignedOutPlaylistDialog';
import styles from './AddTrackToPlaylistButton.module.css';
import playlistStyles from './Playlists.module.css';
import { useLocalization } from '../../localization/LocalizationProvider';

const AddTrackToPlaylistDialog = lazy(() => import('./AddTrackToPlaylistDialog').then((module) => ({
  default: module.AddTrackToPlaylistDialog
})));

export interface AddTrackToPlaylistButtonProps {
  track: AudioTrackSummary;
  viewerId?: string | null;
  accountPending?: boolean;
  accountUnavailable?: boolean;
}

/** Adds a ready MediaTrack without nesting the action inside its playback target. */
export const AddTrackToPlaylistButton = ({
  track,
  viewerId,
  accountPending = false,
  accountUnavailable = false
}: AddTrackToPlaylistButtonProps) => {
  const { t } = useLocalization();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const loadingCloseRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const ownerRef = useRef(viewerId);
  const visibleOpen = ownerRef.current === viewerId && open;
  const capabilities = useQuery(listenerCapabilitiesQuery());

  useEffect(() => {
    ownerRef.current = viewerId;
    setOpen(false);
  }, [viewerId]);

  if (!capabilities.data?.playlists) return null;

  return (
    <>
      <button
        aria-expanded={visibleOpen}
        aria-haspopup="dialog"
        aria-label={t('playlist.add_one.button_label', {
          title: track.title || t('content.title.untitled_track')
        })}
        className={styles.trigger}
        disabled={accountPending}
        onClick={() => setOpen(true)}
        ref={triggerRef}
        title={t('playlist.add_one.button_title')}
        type="button"
      >
        <ListPlus aria-hidden="true" focusable="false" />
      </button>
      {visibleOpen && !viewerId && (
        <SignedOutPlaylistDialog
          accountUnavailable={accountUnavailable}
          description={t('playlist.add_one.signed_out_description')}
          onClose={() => setOpen(false)}
          returnFocusRef={triggerRef}
          title={t('playlist.add_one.signed_out_title')}
        />
      )}
      {visibleOpen && viewerId && (
        <Suspense fallback={(
          <ModalDialog
            description={t('playlist.add_one.choose_description', {
              title: track.title || t('content.title.untitled_track')
            })}
            initialFocusRef={loadingCloseRef}
            kicker={t('playlist.add_one.button_title')}
            onClose={() => setOpen(false)}
            returnFocusRef={triggerRef}
            title={t('playlist.add_one.opening_title')}
          >
            <p aria-busy="true" className={styles.state}>{t('playlist.add_one.loading')}</p>
            <div className={playlistStyles.dialogActions}>
              <button className={playlistStyles.secondaryButton} onClick={() => setOpen(false)} ref={loadingCloseRef} type="button">{t('common.action.close')}</button>
            </div>
          </ModalDialog>
        )}>
          <AddTrackToPlaylistDialog
            key={viewerId}
            onClose={() => setOpen(false)}
            returnFocusRef={triggerRef}
            track={track}
            viewerId={viewerId}
          />
        </Suspense>
      )}
    </>
  );
};

export default AddTrackToPlaylistButton;
