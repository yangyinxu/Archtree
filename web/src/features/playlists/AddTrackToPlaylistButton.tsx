import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ListPlus } from 'lucide-react';

import type { AudioTrackSummary } from '../../api/contentSchemas';
import { listenerCapabilitiesQuery } from '../../api/listenerCapabilities';
import { ModalDialog } from '../../components/ModalDialog';
import { SignedOutPlaylistDialog } from './SignedOutPlaylistDialog';
import styles from './AddTrackToPlaylistButton.module.css';
import playlistStyles from './Playlists.module.css';

const AddTrackToPlaylistDialog = lazy(() => import('./AddTrackToPlaylistDialog').then((module) => ({
  default: module.AddTrackToPlaylistDialog
})));

/** Adds a ready Soundtrack without nesting the action inside its playback target. */
export const AddTrackToPlaylistButton = ({
  track,
  viewerId,
  accountPending = false,
  accountUnavailable = false
}: {
  track: AudioTrackSummary;
  viewerId?: string | null;
  accountPending?: boolean;
  accountUnavailable?: boolean;
}) => {
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
        aria-label={`Add ${track.title || 'Untitled soundtrack'} to Playlist`}
        className={styles.trigger}
        disabled={accountPending}
        onClick={() => setOpen(true)}
        ref={triggerRef}
        title="Add to Playlist"
        type="button"
      >
        <ListPlus aria-hidden="true" focusable="false" />
      </button>
      {visibleOpen && !viewerId && (
        <SignedOutPlaylistDialog
          accountUnavailable={accountUnavailable}
          description="Playlists are private to your Finitude account. Opening this action never starts playback."
          onClose={() => setOpen(false)}
          returnFocusRef={triggerRef}
          title="Log in to add to a Playlist"
        />
      )}
      {visibleOpen && viewerId && (
        <Suspense fallback={(
          <ModalDialog
            description={`Choose where to add “${track.title || 'Untitled soundtrack'}”. This action never starts playback.`}
            initialFocusRef={loadingCloseRef}
            kicker="Add to Playlist"
            onClose={() => setOpen(false)}
            returnFocusRef={triggerRef}
            title="Opening your Playlists"
          >
            <p aria-busy="true" className={styles.state}>Loading your Playlists…</p>
            <div className={playlistStyles.dialogActions}>
              <button className={playlistStyles.secondaryButton} onClick={() => setOpen(false)} ref={loadingCloseRef} type="button">Close</button>
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
