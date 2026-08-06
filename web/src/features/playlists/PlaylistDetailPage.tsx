import { lazy, Suspense, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ListMusic, Play, Plus } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router';

import { ApiError } from '../../api/client';
import {
  captureAccountOperation,
  isAccountOperationCurrent,
  type AccountOperationGuard
} from '../../api/accountEpoch';
import {
  createPlaylistIdempotencyKey,
  playlistDetailQuery,
  playlistQueryKeys,
  removePlaylistItem,
  reorderPlaylistItems,
  type PlaylistDetail
} from '../../api/playlists';
import { browserSessionQuery } from '../../api/session';
import { focusMainContent } from '../../app/focusMainContent';
import { ActionMenu } from '../../components/ActionMenu';
import { Artwork } from '../../components/Artwork';
import { ModalDialog } from '../../components/ModalDialog';
import { launchPlaylistPlayback } from '../playback/launchPlayback';
import {
  commitPlaylistDetail,
  playlistSummaryFromDetail,
  revalidatePlaylistLists
} from './playlistCache';
import styles from './Playlists.module.css';

const AddSoundtracksDialog = lazy(() => import('./AddSoundtracksDialog').then((module) => ({
  default: module.AddSoundtracksDialog
})));
const PlaylistDeleteDialog = lazy(() => import('./PlaylistDialogs').then((module) => ({
  default: module.PlaylistDeleteDialog
})));
const PlaylistNameDialog = lazy(() => import('./PlaylistDialogs').then((module) => ({
  default: module.PlaylistNameDialog
})));

const PlaylistDialogLoading = ({
  onClose,
  returnFocusRef
}: {
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}) => {
  const closeRef = useRef<HTMLButtonElement>(null);
  return (
    <ModalDialog
      description="Finitude is opening this private Playlist action."
      initialFocusRef={closeRef}
      kicker="Your Library"
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      title="Opening Playlist action"
    >
      <p aria-busy="true" className={styles.pickerState}>Loading…</p>
      <div className={styles.dialogActions}>
        <button className={styles.secondaryButton} onClick={onClose} ref={closeRef} type="button">Close</button>
      </div>
    </ModalDialog>
  );
};

const durationSeconds = (duration: string | null) => {
  if (!duration) return null;
  const parts = duration.split(':').map(Number);
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !Number.isFinite(part) || part < 0)) {
    return null;
  }
  return parts.reduce((total, part) => total * 60 + part, 0);
};

const durationLabel = (seconds: number) => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours} hr ${minutes} min`;
  return `${Math.max(1, minutes)} min`;
};

const memberMutationMessage = (error: unknown) => {
  if (!(error instanceof ApiError)) return 'Finitude could not confirm that Playlist change.';
  if (error.code === 'idempotency_in_progress') {
    return 'That Playlist change is still being confirmed. Wait a moment, then retry the same action.';
  }
  if (error.code === 'idempotency_key_reused') {
    return 'That retry no longer matches this change. Reload the Playlist and start the action again.';
  }
  if (error.code === 'account_viewer_mismatch' || error.status === 401) {
    return 'Your signed-in account changed. Reload the page before editing this Playlist.';
  }
  if (error.code === 'playlist_revision_conflict' || error.status === 409) {
    return 'This Playlist changed on another device. Finitude loaded the newest version; review it before trying again.';
  }
  if (error.code === 'playlist_item_not_found' || error.status === 404) {
    return 'That Playlist item is no longer available. Finitude is refreshing the list.';
  }
  return error.message;
};

interface ReorderVariables {
  itemIds: string[];
  revision: number;
  idempotencyKey: string;
  announcement: string;
  signature: string;
}

interface RemoveVariables {
  itemId: string;
  revision: number;
  idempotencyKey: string;
  signature: string;
}

/** Provides ordered composition and ready-only playback over one persistent player. */
export const PlaylistDetailPage = () => {
  const { playlistId = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const session = useQuery(browserSessionQuery());
  const viewerId = session.data?.user.id ?? '';
  const playlistQuery = useQuery(playlistDetailQuery(viewerId, playlistId));
  const renameTriggerRef = useRef<HTMLButtonElement>(null);
  const addTriggerRef = useRef<HTMLButtonElement>(null);
  const moreTriggerRef = useRef<HTMLButtonElement>(null);
  const memberHeadingRef = useRef<HTMLHeadingElement>(null);
  const memberActionRefs = useRef(new Map<string, RefObject<HTMLButtonElement | null>>());
  const mutationKeysRef = useRef(new Map<string, string>());
  const [dialog, setDialog] = useState<'rename' | 'add' | 'delete' | null>(null);
  const [feedback, setFeedback] = useState<{ kind: 'error' | 'success'; message: string } | null>(null);
  const [movementAnnouncement, setMovementAnnouncement] = useState('');
  const localOwnerRef = useRef(viewerId);
  const ownsLocalState = localOwnerRef.current === viewerId;
  const visibleDialog = ownsLocalState ? dialog : null;
  const visibleFeedback = ownsLocalState ? feedback : null;
  const visibleMovementAnnouncement = ownsLocalState ? movementAnnouncement : '';
  const detailKey = playlistQueryKeys.detail(viewerId, playlistId);

  const reconcileMutationError = (
    error: unknown,
    guard: AccountOperationGuard | undefined,
    previous?: PlaylistDetail
  ) => {
    if (!guard || !isAccountOperationCurrent(guard, viewerId)) return;
    if (previous) queryClient.setQueryData(detailKey, previous);
    setFeedback({ kind: 'error', message: memberMutationMessage(error) });
    if (error instanceof ApiError && (error.status === 409 || error.status === 404)) {
      void queryClient.invalidateQueries({ queryKey: detailKey, exact: true });
      void revalidatePlaylistLists(queryClient, viewerId, guard);
    }
  };

  const removeMutation = useMutation({
    mutationFn: (variables: RemoveVariables) => removePlaylistItem({
      viewerId,
      playlistId,
      itemId: variables.itemId,
      revision: variables.revision,
      idempotencyKey: variables.idempotencyKey
    }),
    onMutate: async (variables) => {
      const guard = captureAccountOperation(viewerId);
      setFeedback(null);
      await queryClient.cancelQueries({ queryKey: detailKey, exact: true });
      if (!isAccountOperationCurrent(guard, viewerId)) return { guard };
      const previous = queryClient.getQueryData<PlaylistDetail>(detailKey);
      if (previous) {
        const items = previous.items.filter((item) => item.itemId !== variables.itemId);
        queryClient.setQueryData<PlaylistDetail>(detailKey, {
          ...previous,
          items,
          itemCount: items.length,
          revision: previous.revision + 1,
          updatedAt: new Date().toISOString()
        });
      }
      return { previous, guard };
    },
    onError: (error, _variables, context) => reconcileMutationError(
      error,
      context?.guard,
      context?.previous
    ),
    onSuccess: (detail, variables, context) => {
      if (!context?.guard || !isAccountOperationCurrent(context.guard, viewerId)) return;
      // A confirmed receipt is no longer needed for another intentional action.
      mutationKeysRef.current.delete(variables.signature);
      commitPlaylistDetail(queryClient, viewerId, detail, context.guard);
      void revalidatePlaylistLists(queryClient, viewerId, context.guard);
      setFeedback({ kind: 'success', message: 'Soundtrack removed from this Playlist.' });
    }
  });

  const reorderMutation = useMutation({
    mutationFn: (variables: ReorderVariables) => reorderPlaylistItems({
      viewerId,
      playlistId,
      revision: variables.revision,
      itemIds: variables.itemIds,
      idempotencyKey: variables.idempotencyKey
    }),
    onMutate: async (variables) => {
      const guard = captureAccountOperation(viewerId);
      setFeedback(null);
      setMovementAnnouncement(variables.announcement);
      await queryClient.cancelQueries({ queryKey: detailKey, exact: true });
      if (!isAccountOperationCurrent(guard, viewerId)) return { guard };
      const previous = queryClient.getQueryData<PlaylistDetail>(detailKey);
      if (previous) {
        const byId = new Map(previous.items.map((item) => [item.itemId, item]));
        queryClient.setQueryData<PlaylistDetail>(detailKey, {
          ...previous,
          items: variables.itemIds.flatMap((itemId) => {
            const item = byId.get(itemId);
            return item ? [item] : [];
          }),
          revision: previous.revision + 1,
          updatedAt: new Date().toISOString()
        });
      }
      return { previous, guard };
    },
    onError: (error, _variables, context) => {
      if (!context?.guard || !isAccountOperationCurrent(context.guard, viewerId)) return;
      setMovementAnnouncement('Move was not saved.');
      reconcileMutationError(error, context.guard, context.previous);
    },
    onSuccess: (detail, variables, context) => {
      if (!isAccountOperationCurrent(context?.guard, viewerId)) return;
      mutationKeysRef.current.delete(variables.signature);
      commitPlaylistDetail(queryClient, viewerId, detail, context.guard);
      void revalidatePlaylistLists(queryClient, viewerId, context.guard);
    }
  });

  useEffect(() => {
    localOwnerRef.current = viewerId;
    setDialog(null);
    setFeedback(null);
    setMovementAnnouncement('');
    memberActionRefs.current.clear();
    mutationKeysRef.current.clear();
    removeMutation.reset();
    reorderMutation.reset();
  }, [playlistId, viewerId]);

  const playlist = playlistQuery.data;
  const readyTracks = useMemo(() => playlist?.items.flatMap((item) => (
    item.availability === 'ready' && item.audioTrack ? [item.audioTrack] : []
  )) ?? [], [playlist]);
  const knownDuration = useMemo(() => readyTracks.reduce<number | null>((total, track) => {
    const seconds = durationSeconds(track.duration);
    return seconds === null || total === null ? null : total + seconds;
  }, 0), [readyTracks]);
  const mutationPending = removeMutation.isPending || reorderMutation.isPending;

  const memberActionRef = (itemId: string) => {
    const existing = memberActionRefs.current.get(itemId);
    if (existing) return existing;
    const created: RefObject<HTMLButtonElement | null> = { current: null };
    memberActionRefs.current.set(itemId, created);
    return created;
  };

  const focusAfterMemberRemoval = (itemId: string) => {
    if (!playlist) return;
    const index = playlist.items.findIndex((item) => item.itemId === itemId);
    const adjacent = index >= 0
      ? playlist.items[index + 1] ?? playlist.items[index - 1]
      : undefined;
    const target = adjacent
      ? memberActionRefs.current.get(adjacent.itemId)?.current
      : memberHeadingRef.current;
    (target ?? memberHeadingRef.current)?.focus({ preventScroll: true });
  };

  const moveItem = (itemId: string, direction: -1 | 1) => {
    if (!playlist || mutationPending) return;
    const index = playlist.items.findIndex((item) => item.itemId === itemId);
    const destination = index + direction;
    if (index < 0 || destination < 0 || destination >= playlist.items.length) return;
    const order = playlist.items.map((item) => item.itemId);
    [order[index], order[destination]] = [order[destination], order[index]];
    const title = playlist.items[index].audioTrack?.title || 'Unavailable Soundtrack';
    const signature = `order:${playlist.revision}:${order.join(',')}`;
    const idempotencyKey = mutationKeysRef.current.get(signature) ?? createPlaylistIdempotencyKey();
    mutationKeysRef.current.set(signature, idempotencyKey);
    reorderMutation.mutate({
      itemIds: order,
      revision: playlist.revision,
      idempotencyKey,
      signature,
      announcement: `${title} moved to position ${destination + 1} of ${order.length}.`
    });
  };

  if (session.isPending) {
    return <div className={styles.page}><div aria-busy="true" className={styles.state}>Checking your account…</div></div>;
  }
  if (session.isError) {
    return (
      <div className={styles.page}><div className={styles.state} role="alert">
        <h1>Your account is out of reach</h1>
        <button className={styles.secondaryButton} onClick={() => session.refetch()} type="button">Try again</button>
      </div></div>
    );
  }
  if (!session.data) {
    return (
      <div className={styles.page}><div className={styles.state}>
        <ListMusic aria-hidden="true" />
        <h1>Log in to open this Playlist</h1>
        <p>Private Playlist addresses never reveal another listener's music.</p>
        <Link className={styles.primaryButton} state={{ from: `/playlists/${playlistId}` }} to="/login">Log in</Link>
      </div></div>
    );
  }
  if (playlistQuery.isPending) {
    return <div className={styles.page}><div aria-busy="true" className={styles.state}>Opening Playlist…</div></div>;
  }
  if (playlistQuery.isError) {
    const notFound = playlistQuery.error instanceof ApiError && playlistQuery.error.status === 404;
    return (
      <div className={styles.page}><div className={styles.state} role={notFound ? undefined : 'alert'}>
        <ListMusic aria-hidden="true" />
        <h1>{notFound ? 'Playlist not found' : 'This Playlist could not be loaded'}</h1>
        <p>{notFound
          ? 'It may have been deleted, or it belongs to another listener.'
          : 'Finitude could not reach your private Playlist.'}</p>
        {notFound
          ? <Link className={styles.secondaryButton} to="/playlists">Back to Playlists</Link>
          : <button className={styles.secondaryButton} onClick={() => playlistQuery.refetch()} type="button">Try again</button>}
      </div></div>
    );
  }
  if (!playlist) {
    return <div className={styles.page}><div aria-busy="true" className={styles.state}>Opening Playlist…</div></div>;
  }

  const summary = playlistSummaryFromDetail(playlist);

  return (
    <div className={styles.page}>
      <header className={styles.detailHeader}>
        <Artwork
          alt={`${playlist.name} Playlist artwork`}
          className={styles.playlistArtwork}
          fetchPriority="high"
          kind="audioTrack"
          loading="eager"
          sizes="(max-width: 640px) 9rem, 14rem"
          src={playlist.artworkUrl}
        />
        <div className={styles.detailCopy}>
          <p className={styles.eyebrow}>Private Playlist</p>
          <h1 title={playlist.name}>{playlist.name}</h1>
          <p className={styles.detailMetadata}>
            {playlist.itemCount} soundtrack{playlist.itemCount === 1 ? '' : 's'}
            {knownDuration !== null && knownDuration > 0 ? ` · ${durationLabel(knownDuration)}` : ''}
            {readyTracks.length !== playlist.itemCount ? ` · ${playlist.itemCount - readyTracks.length} unavailable` : ''}
          </p>
          <div className={styles.detailActions}>
            <button
              aria-label="Play"
              className={styles.playButton}
              disabled={readyTracks.length === 0}
              onClick={() => { void launchPlaylistPlayback(readyTracks, viewerId); }}
              title={readyTracks.length === 0 ? 'No ready Soundtracks to play' : `Play ${playlist.name}`}
              type="button"
            >
              <Play aria-hidden="true" fill="currentColor" focusable="false" />
            </button>
            <button className={styles.secondaryButton} disabled={mutationPending} onClick={() => setDialog('add')} ref={addTriggerRef} type="button">
              <Plus aria-hidden="true" /> Add Soundtracks
            </button>
            <button className={styles.secondaryButton} disabled={mutationPending} onClick={() => setDialog('rename')} ref={renameTriggerRef} type="button">Rename</button>
            <ActionMenu
              items={[{
                label: 'Delete Playlist',
                destructive: true,
                disabled: mutationPending,
                restoreFocus: false,
                onSelect: () => setDialog('delete')
              }]}
              label={`More actions for ${playlist.name}`}
              triggerRef={moreTriggerRef}
            />
          </div>
        </div>
      </header>

      {visibleFeedback && (
        <p className={visibleFeedback.kind === 'error' ? styles.feedbackError : styles.feedbackSuccess} role={visibleFeedback.kind === 'error' ? 'alert' : 'status'}>
          {visibleFeedback.message}
        </p>
      )}
      <p aria-atomic="true" aria-live="polite" className="visually-hidden">{visibleMovementAnnouncement}</p>

      <section aria-labelledby="playlist-soundtracks-title" className={styles.memberSection}>
        <div className={styles.sectionHeading}>
          <div>
            <p className={styles.eyebrow}>In this Playlist</p>
            <h2 id="playlist-soundtracks-title" ref={memberHeadingRef} tabIndex={-1}>Soundtracks</h2>
          </div>
          <p>{playlist.items.length > 0 ? 'Use each row menu to remove or move it.' : 'Build this Playlist one Soundtrack at a time.'}</p>
        </div>
        {playlist.items.length === 0 ? (
          <div className={styles.emptyState}>
            <ListMusic aria-hidden="true" />
            <h3>This Playlist is empty</h3>
            <p>Search the ready catalog and add the first Soundtrack.</p>
            <button className={styles.primaryButton} onClick={() => setDialog('add')} type="button">Add Soundtracks</button>
          </div>
        ) : (
          <>
            <div aria-hidden="true" className={styles.memberTableHeader}>
              <span>#</span>
              <span className={styles.memberTitleHeading}>Title</span>
              <span>Duration</span>
              <span />
            </div>
            <ol aria-label={`${playlist.name} Soundtracks`} className={styles.memberList}>
            {playlist.items.map((item, index) => {
              const track = item.audioTrack;
              const title = track?.title || 'Unavailable Soundtrack';
              return (
                <li className={`${styles.memberRow} ${!track ? styles.unavailableRow : ''}`} key={item.itemId}>
                  <button
                    aria-label={track ? `Play ${title}` : `${title} cannot be played`}
                    className={styles.memberPrimary}
                    disabled={!track}
                    onClick={() => {
                      if (track) void launchPlaylistPlayback(readyTracks, viewerId, track.id);
                    }}
                    type="button"
                  >
                    <span className={styles.memberPosition}>{index + 1}</span>
                    <Artwork alt="" className={styles.memberArtwork} kind="audioTrack" sizes="3.25rem" src={track?.artworkUrl} />
                    <span className={styles.memberCopy}>
                      <span title={title}>{title}</span>
                      <span>{track
                        ? [track.artistNames.join(', '), track.albumTitle].filter(Boolean).join(' · ') || 'Soundtrack'
                        : 'This member is no longer ready in the catalog.'}</span>
                    </span>
                    <span className={styles.memberDuration}>{track?.duration || '—'}</span>
                  </button>
                  <span className={styles.memberMenu}>
                    <ActionMenu
                      items={[
                        { label: 'Move Up', disabled: mutationPending || index === 0, onSelect: () => moveItem(item.itemId, -1) },
                        { label: 'Move Down', disabled: mutationPending || index === playlist.items.length - 1, onSelect: () => moveItem(item.itemId, 1) },
                        {
                          label: 'Remove from Playlist',
                          destructive: true,
                          disabled: mutationPending,
                          restoreFocus: false,
                          onSelect: () => {
                            focusAfterMemberRemoval(item.itemId);
                            const signature = `remove:${playlist.revision}:${item.itemId}`;
                            const idempotencyKey = mutationKeysRef.current.get(signature)
                              ?? createPlaylistIdempotencyKey();
                            mutationKeysRef.current.set(signature, idempotencyKey);
                            removeMutation.mutate({
                              itemId: item.itemId,
                              revision: playlist.revision,
                              idempotencyKey,
                              signature
                            });
                          }
                        }
                      ]}
                      label={`Actions for ${title}`}
                      triggerRef={memberActionRef(item.itemId)}
                    />
                  </span>
                </li>
              );
            })}
            </ol>
          </>
        )}
      </section>

      {visibleDialog === 'rename' && (
        <Suspense fallback={<PlaylistDialogLoading onClose={() => setDialog(null)} returnFocusRef={renameTriggerRef} />}>
          <PlaylistNameDialog
            key={viewerId}
            mode="rename"
            onClose={() => setDialog(null)}
            onConfirmed={() => setDialog(null)}
            playlist={summary}
            returnFocusRef={renameTriggerRef}
            viewerId={viewerId}
          />
        </Suspense>
      )}
      {visibleDialog === 'add' && (
        <Suspense fallback={<PlaylistDialogLoading onClose={() => setDialog(null)} returnFocusRef={addTriggerRef} />}>
          <AddSoundtracksDialog
            key={viewerId}
            onClose={() => setDialog(null)}
            playlist={playlist}
            returnFocusRef={addTriggerRef}
            viewerId={viewerId}
          />
        </Suspense>
      )}
      {visibleDialog === 'delete' && (
        <Suspense fallback={<PlaylistDialogLoading onClose={() => setDialog(null)} returnFocusRef={moreTriggerRef} />}>
          <PlaylistDeleteDialog
            key={viewerId}
            onClose={() => setDialog(null)}
            onDeleted={() => {
              navigate('/playlists', { replace: true });
              focusMainContent();
            }}
            playlist={summary}
            returnFocusRef={moreTriggerRef}
            viewerId={viewerId}
          />
        </Suspense>
      )}
    </div>
  );
};

export default PlaylistDetailPage;
