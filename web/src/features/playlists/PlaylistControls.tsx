import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router';

import type { PlaylistSummary } from '../../api/playlists';
import { focusMainContent } from '../../app/focusMainContent';
import { ActionMenu } from '../../components/ActionMenu';
import { useLocalization } from '../../localization/LocalizationProvider';

const PlaylistDeleteDialog = lazy(() => import('./PlaylistDialogs').then((module) => ({
  default: module.PlaylistDeleteDialog
})));
const PlaylistNameDialog = lazy(() => import('./PlaylistDialogs').then((module) => ({
  default: module.PlaylistNameDialog
})));
const SignedOutPlaylistDialog = lazy(() => import('./SignedOutPlaylistDialog').then((module) => ({
  default: module.SignedOutPlaylistDialog
})));

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
  const { t } = useLocalization();
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
        aria-label={t('playlist.action.new')}
        className={className}
        disabled={accountPending}
        onClick={() => setDialog(viewerId ? 'create' : 'signed-out')}
        ref={triggerRef}
        type="button"
      >
        <Plus aria-hidden="true" focusable="false" />
        <span>{t('playlist.action.new')}</span>
      </button>
      {visibleDialog === 'create' && viewerId && (
        <Suspense fallback={null}>
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
        </Suspense>
      )}
      {visibleDialog === 'signed-out' && (
        <Suspense fallback={null}>
          <SignedOutPlaylistDialog
            accountUnavailable={accountUnavailable}
            onClose={() => setDialog(null)}
            returnFocusRef={triggerRef}
          />
        </Suspense>
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
  const { t } = useLocalization();
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
          { label: t('playlist.action.rename'), restoreFocus: false, onSelect: () => setDialog('rename') },
          { label: t('playlist.action.delete'), destructive: true, restoreFocus: false, onSelect: () => setDialog('delete') }
        ]}
        label={t('playlist.actions.for', { name: playlist.name })}
        triggerRef={triggerRef}
      />
      {visibleDialog === 'rename' && (
        <Suspense fallback={null}>
          <PlaylistNameDialog
            key={viewerId}
            mode="rename"
            onClose={() => setDialog(null)}
            onConfirmed={() => setDialog(null)}
            playlist={playlist}
            returnFocusRef={triggerRef}
            viewerId={viewerId}
          />
        </Suspense>
      )}
      {visibleDialog === 'delete' && (
        <Suspense fallback={null}>
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
        </Suspense>
      )}
    </>
  );
};
