import { useEffect, useRef, useState, type RefObject } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';

import { ApiError } from '../../api/client';
import { captureAccountOperation, isAccountOperationCurrent } from '../../api/accountEpoch';
import type { AudioTrackSummary } from '../../api/contentSchemas';
import {
  addPlaylistItem,
  createPlaylistIdempotencyKey,
  playlistMembershipsQuery,
  playlistPageQuery,
  playlistQueryKeys,
  type PlaylistDetail,
  type PlaylistSummary
} from '../../api/playlists';
import { Artwork } from '../../components/Artwork';
import { ModalDialog } from '../../components/ModalDialog';
import { commitPlaylistDetail, revalidatePlaylistLists } from './playlistCache';
import styles from './AddTrackToPlaylistButton.module.css';
import playlistStyles from './Playlists.module.css';

const addFailureMessage = (error: unknown) => {
  if (!(error instanceof ApiError)) return 'Finitude could not confirm that addition.';
  if (error.code === 'playlist_item_limit_reached') return 'That Playlist already contains 500 Soundtracks.';
  if (error.code === 'idempotency_in_progress') return 'That addition is still being confirmed. Wait a moment, then retry.';
  if (error.code === 'idempotency_key_reused') return 'That retry no longer matches this addition. Close the picker and start again.';
  if (error.code === 'account_viewer_mismatch' || error.status === 401) {
    return 'Your signed-in account changed. Reload the page before adding this Soundtrack.';
  }
  if (error.code === 'playlist_revision_conflict' || error.status === 409) {
    return 'That Playlist changed on another device. Its latest revision is loading.';
  }
  return error.message;
};

/** Loads the owner-scoped picker only after its lightweight row action is activated. */
export const AddTrackToPlaylistDialog = ({
  track,
  viewerId,
  onClose,
  returnFocusRef
}: {
  track: AudioTrackSummary;
  viewerId: string;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}) => {
  const queryClient = useQueryClient();
  const closeRef = useRef<HTMLButtonElement>(null);
  const idempotencyKeysRef = useRef(new Map<string, string>());
  const [addedIds, setAddedIds] = useState(new Set<string>());
  const localOwner = useRef(viewerId);
  const ownsLocalState = localOwner.current === viewerId;
  const currentAddedIds = ownsLocalState ? addedIds : new Set<string>();
  const playlists = useQuery({
    ...playlistPageQuery(viewerId, { limit: 100 }),
    enabled: true
  });
  const memberships = useQuery({
    ...playlistMembershipsQuery(viewerId, [track.id]),
    enabled: true
  });
  const mutation = useMutation({
    mutationFn: (playlist: PlaylistSummary) => {
      const signature = `${playlist.id}:${playlist.revision}:${track.id}`;
      const idempotencyKey = idempotencyKeysRef.current.get(signature)
        ?? createPlaylistIdempotencyKey();
      idempotencyKeysRef.current.set(signature, idempotencyKey);
      return addPlaylistItem({
        viewerId,
        playlistId: playlist.id,
        revision: playlist.revision,
        audioTrackId: track.id,
        idempotencyKey
      }).then((detail) => ({ detail, signature }));
    },
    onMutate: () => captureAccountOperation(viewerId),
    onSuccess: ({ detail, signature }, _variables, guard) => {
      if (!isAccountOperationCurrent(guard, viewerId)) return;
      idempotencyKeysRef.current.delete(signature);
      commitPlaylistDetail(queryClient, viewerId, detail, guard);
      void revalidatePlaylistLists(queryClient, viewerId, guard);
      setAddedIds((current) => new Set(current).add(detail.id));
    },
    onError: (error, playlist, guard) => {
      if (!isAccountOperationCurrent(guard, viewerId)) return;
      if (error instanceof ApiError && error.status === 409) {
        if (error.code !== 'idempotency_in_progress') {
          idempotencyKeysRef.current.delete(`${playlist.id}:${playlist.revision}:${track.id}`);
        }
        void queryClient.invalidateQueries({ queryKey: playlistQueryKeys.lists(viewerId) });
      }
    }
  });

  useEffect(() => {
    localOwner.current = viewerId;
    idempotencyKeysRef.current.clear();
    setAddedIds(new Set());
    mutation.reset();
  }, [track.id, viewerId]);

  return (
    <ModalDialog
      closeDisabled={mutation.isPending}
      description={`Choose where to add “${track.title || 'Untitled soundtrack'}”. This action never starts playback.`}
      initialFocusRef={closeRef}
      kicker="Add to Playlist"
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      title="Choose a Playlist"
    >
      {ownsLocalState && mutation.isError && <p className={playlistStyles.feedbackError} role="alert">{addFailureMessage(mutation.error)}</p>}
      {memberships.isError && (
        <p className={playlistStyles.feedbackError} role="alert">
          Existing membership could not be checked. Adding remains safe and will not create a duplicate.
        </p>
      )}
      {playlists.isPending ? (
        <p aria-busy="true" className={styles.state}>Loading your Playlists…</p>
      ) : playlists.isError ? (
        <div className={styles.state} role="alert">
          <span>Your Playlists could not be loaded.</span>
          <button className={playlistStyles.textButton} onClick={() => playlists.refetch()} type="button">Try again</button>
        </div>
      ) : playlists.data.items.length === 0 ? (
        <div className={styles.state}>
          <span>Create a Playlist first, then return to add this Soundtrack.</span>
          <Link className={playlistStyles.primaryButton} onClick={onClose} to="/playlists">Create a Playlist</Link>
        </div>
      ) : (
        <ul aria-label="Choose a Playlist" className={styles.list}>
          {playlists.data.items.map((playlist) => {
            const cachedDetail = queryClient.getQueryData<PlaylistDetail>(
              playlistQueryKeys.detail(viewerId, playlist.id)
            );
            const alreadyAdded = currentAddedIds.has(playlist.id)
              || memberships.data?.items.some((membership) => (
                membership.audioTrackId === track.id
                && membership.playlistIds.includes(playlist.id)
              ))
              || cachedDetail?.items.some((item) => item.audioTrackId === track.id);
            const checkingMembership = memberships.isPending;
            return (
              <li key={playlist.id}>
                <span className={styles.listIdentity}>
                  <Artwork
                    alt=""
                    className={styles.playlistArtwork}
                    kind="audioTrack"
                    sizes="2.85rem"
                    src={playlist.artworkUrl}
                  />
                  <span className={styles.listCopy}>
                    <span title={playlist.name}>{playlist.name}</span>
                    <span>Playlist · {playlist.itemCount} soundtrack{playlist.itemCount === 1 ? '' : 's'}</span>
                  </span>
                </span>
                <button
                  aria-label={checkingMembership
                    ? `Checking whether ${track.title || 'Untitled soundtrack'} is in ${playlist.name}`
                    : alreadyAdded
                    ? `${track.title || 'Untitled soundtrack'} is already in ${playlist.name}`
                    : playlist.itemCount >= 500
                      ? `${playlist.name} is full`
                      : `Add ${track.title || 'Untitled soundtrack'} to ${playlist.name}`}
                  className={playlistStyles.secondaryButton}
                  disabled={checkingMembership || Boolean(alreadyAdded) || playlist.itemCount >= 500 || mutation.isPending}
                  onClick={() => mutation.mutate(playlist)}
                  type="button"
                >
                  {checkingMembership ? 'Checking…' : alreadyAdded ? 'Added' : playlist.itemCount >= 500 ? 'Full' : 'Add'}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className={playlistStyles.dialogActions}>
        <Link className={playlistStyles.textButton} onClick={onClose} to="/playlists">Manage Playlists</Link>
        <button className={playlistStyles.secondaryButton} disabled={mutation.isPending} onClick={onClose} ref={closeRef} type="button">Done</button>
      </div>
    </ModalDialog>
  );
};

export default AddTrackToPlaylistDialog;
