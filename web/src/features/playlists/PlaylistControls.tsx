import { useEffect, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router';

import type { PlaylistSummary } from '../../api/playlists';
import { focusMainContent } from '../../app/focusMainContent';
import { ActionMenu } from '../../components/ActionMenu';
import {
  PlaylistDeleteDialog,
  PlaylistNameDialog
} from './PlaylistDialogs';
import { SignedOutPlaylistDialog } from './SignedOutPlaylistDialog';

export interface NewPlaylistButtonProps {
  viewerId?: string;
  accountPending?: boolean;
  accountUnavailable?: boolean;
  className?: string;
  onCreated?: (playlistId: string) => void;
}

/** Keeps Create visible while routing signed-out listeners to an explanatory dialog. */
export const NewPlaylistButton = ({
  viewerId,
  accountPending = false,
  accountUnavailable = false,
  className,
  onCreated
}: NewPlaylistButtonProps) => {
  const navigate = useNavigate();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [dialog, setDialog] = useState<'create' | 'signed-out' | null>(null);
  const ownerRef = useRef(viewerId);
  const visibleDialog = ownerRef.current === viewerId ? dialog : null;

  useEffect(() => {
    ownerRef.current = viewerId;
    setDialog(null);
  }, [viewerId]);

  return (
    <>
      <button
        aria-label="New Playlist"
        className={className}
        disabled={accountPending}
        onClick={() => setDialog(viewerId ? 'create' : 'signed-out')}
        ref={triggerRef}
        type="button"
      >
        <Plus aria-hidden="true" focusable="false" />
        <span>New Playlist</span>
      </button>
      {visibleDialog === 'create' && viewerId && (
        <PlaylistNameDialog
          key={viewerId}
          mode="create"
          onClose={() => setDialog(null)}
          onConfirmed={(playlistId) => {
            setDialog(null);
            onCreated?.(playlistId);
            if (!onCreated) {
              navigate(`/playlists/${encodeURIComponent(playlistId)}`);
              focusMainContent();
            }
          }}
          returnFocusRef={triggerRef}
          viewerId={viewerId}
        />
      )}
      {visibleDialog === 'signed-out' && (
        <SignedOutPlaylistDialog
          accountUnavailable={accountUnavailable}
          onClose={() => setDialog(null)}
          returnFocusRef={triggerRef}
        />
      )}
    </>
  );
};

/** Owns revision-aware Rename/Delete dialogs while the row remains the focus anchor. */
export const PlaylistSummaryActions = ({
  playlist,
  viewerId,
  onDeleted
}: {
  playlist: PlaylistSummary;
  viewerId: string;
  onDeleted?: () => void;
}) => {
  const navigate = useNavigate();
  const location = useLocation();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [dialog, setDialog] = useState<'rename' | 'delete' | null>(null);
  const ownerRef = useRef(viewerId);
  const visibleDialog = ownerRef.current === viewerId ? dialog : null;

  useEffect(() => {
    ownerRef.current = viewerId;
    setDialog(null);
  }, [viewerId]);

  return (
    <>
      <ActionMenu
        items={[
          { label: 'Rename', restoreFocus: false, onSelect: () => setDialog('rename') },
          { label: 'Delete', destructive: true, restoreFocus: false, onSelect: () => setDialog('delete') }
        ]}
        label={`Actions for ${playlist.name}`}
        triggerRef={triggerRef}
      />
      {visibleDialog === 'rename' && (
        <PlaylistNameDialog
          key={viewerId}
          mode="rename"
          onClose={() => setDialog(null)}
          onConfirmed={() => setDialog(null)}
          playlist={playlist}
          returnFocusRef={triggerRef}
          viewerId={viewerId}
        />
      )}
      {visibleDialog === 'delete' && (
        <PlaylistDeleteDialog
          key={viewerId}
          onClose={() => setDialog(null)}
          onDeleted={() => {
            setDialog(null);
            onDeleted?.();
            if (location.pathname === `/playlists/${encodeURIComponent(playlist.id)}`) {
              navigate('/playlists', { replace: true });
            }
            focusMainContent();
          }}
          playlist={playlist}
          returnFocusRef={triggerRef}
          viewerId={viewerId}
        />
      )}
    </>
  );
};
