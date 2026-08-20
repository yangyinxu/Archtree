import { useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { ApiError } from '../../api/client';
import { captureAccountOperation, isAccountOperationCurrent } from '../../api/accountEpoch';
import { contentByline, type AudioTrackSummary } from '../../api/contentSchemas';
import {
  addPlaylistItem,
  createPlaylistIdempotencyKey,
  playlistQueryKeys,
  type PlaylistDetail
} from '../../api/playlists';
import { listenerSearchQuery } from '../../api/listener';
import { Artwork } from '../../components/Artwork';
import { ModalDialog } from '../../components/ModalDialog';
import { commitPlaylistDetail, revalidatePlaylistLists } from './playlistCache';
import styles from './Playlists.module.css';

const addErrorMessage = (error: unknown) => {
  if (!(error instanceof ApiError)) return 'Finitude could not confirm that addition.';
  if (error.code === 'playlist_item_limit_reached') return 'This Playlist already contains 500 MediaTracks.';
  if (error.code === 'idempotency_in_progress') {
    return 'That addition is still being confirmed. Wait a moment, then try this MediaTrack again.';
  }
  if (error.code === 'idempotency_key_reused') {
    return 'That retry no longer matches this addition. Close the picker and start again.';
  }
  if (error.code === 'account_viewer_mismatch' || error.status === 401) {
    return 'Your signed-in account changed. Reload the page before adding a MediaTrack.';
  }
  if (error.code === 'playlist_revision_conflict' || error.status === 409) {
    return 'This Playlist changed on another device. Finitude is loading the newest version.';
  }
  if (error.code === 'audio_track_not_found' || error.status === 404) {
    return 'That MediaTrack is no longer ready to add.';
  }
  return error.message;
};

/** Searches the public ready catalog and adds one unique MediaTrack at a time. */
export const AddSoundtracksDialog = ({
  playlist,
  viewerId,
  onClose,
  returnFocusRef
}: {
  playlist: PlaylistDetail;
  viewerId: string;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}) => {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const idempotencyKeysRef = useRef(new Map<string, string>());
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [message, setMessage] = useState('');
  const localOwner = useRef(viewerId);
  const ownsLocalState = localOwner.current === viewerId;
  const results = useQuery(listenerSearchQuery(query));
  const existingIds = new Set(playlist.items.map((item) => item.audioTrackId));
  const mutation = useMutation({
    mutationFn: ({ track, revision }: { track: AudioTrackSummary; revision: number }) => {
      const signature = `${track.id}:${revision}`;
      const key = idempotencyKeysRef.current.get(signature) ?? createPlaylistIdempotencyKey();
      idempotencyKeysRef.current.set(signature, key);
      return addPlaylistItem({
        viewerId,
        playlistId: playlist.id,
        revision,
        audioTrackId: track.id,
        idempotencyKey: key
      });
    },
    onMutate: () => captureAccountOperation(viewerId),
    onSuccess: (detail, variables, guard) => {
      if (!guard || !isAccountOperationCurrent(guard, viewerId)) return;
      idempotencyKeysRef.current.delete(`${variables.track.id}:${variables.revision}`);
      commitPlaylistDetail(queryClient, viewerId, detail, guard);
      void revalidatePlaylistLists(queryClient, viewerId, guard);
      setMessage(`${variables.track.title || 'Untitled MediaTrack'} added.`);
    },
    onError: (error, _variables, guard) => {
      if (!guard || !isAccountOperationCurrent(guard, viewerId)) return;
      setMessage('');
      if (error instanceof ApiError && error.status === 409) {
        void queryClient.invalidateQueries({
          queryKey: playlistQueryKeys.detail(viewerId, playlist.id),
          exact: true
        });
        void revalidatePlaylistLists(queryClient, viewerId, guard);
      }
    }
  });

  useEffect(() => {
    localOwner.current = viewerId;
    idempotencyKeysRef.current.clear();
    setDraft('');
    setQuery('');
    setMessage('');
    mutation.reset();
  }, [playlist.id, viewerId]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized = draft.trim();
    if (!normalized) {
      inputRef.current?.focus();
      return;
    }
    setMessage('');
    setQuery(normalized);
  };

  return (
    <ModalDialog
      closeDisabled={mutation.isPending}
      description="Search finds ready MediaTracks only. Adding music does not save or download it."
      initialFocusRef={inputRef}
      kicker={playlist.name}
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      title="Add MediaTracks"
      wide
    >
      <form className={styles.pickerSearch} onSubmit={submit} role="search">
        <label className="visually-hidden" htmlFor="playlist-soundtrack-search">Search ready MediaTracks</label>
        <input
          id="playlist-soundtrack-search"
          onChange={(event) => setDraft(event.currentTarget.value)}
          placeholder="Search by MediaTrack, album, or artist"
          ref={inputRef}
          type="search"
          value={draft}
        />
        <button className={styles.secondaryButton} type="submit">Search</button>
      </form>

      {ownsLocalState && message && <p aria-live="polite" className={styles.feedbackSuccess}>{message}</p>}
      {ownsLocalState && mutation.isError && <p className={styles.feedbackError} role="alert">{addErrorMessage(mutation.error)}</p>}

      {!query ? (
        <p className={styles.pickerState}>Enter a search to find a MediaTrack.</p>
      ) : results.isPending ? (
        <p aria-busy="true" className={styles.pickerState}>Searching MediaTracks…</p>
      ) : results.isError ? (
        <div className={styles.pickerState} role="alert">
          <span>Search is unavailable.</span>
          <button className={styles.textButton} onClick={() => results.refetch()} type="button">Try again</button>
        </div>
      ) : results.data.audioTracks.length === 0 ? (
        <p className={styles.pickerState}>No ready MediaTracks matched “{query}”.</p>
      ) : (
        <ul className={styles.pickerResults} aria-label={`MediaTrack results for ${query}`}>
          {results.data.audioTracks.map((track) => {
            const exists = existingIds.has(track.id);
            return (
              <li key={track.id}>
                <Artwork alt="" className={styles.pickerArtwork} kind="audioTrack" sizes="3rem" src={track.artworkUrl} />
                <span className={styles.pickerCopy}>
                  <span title={track.title || 'Untitled MediaTrack'}>{track.title || 'Untitled MediaTrack'}</span>
                  <span>{contentByline(track) || track.albumTitle || 'MediaTrack'}</span>
                </span>
                <button
                  aria-label={exists
                    ? `${track.title || 'Untitled MediaTrack'} is already in ${playlist.name}`
                    : `Add ${track.title || 'Untitled MediaTrack'} to ${playlist.name}`}
                  className={styles.secondaryButton}
                  disabled={exists || mutation.isPending || playlist.itemCount >= 500}
                  onClick={() => mutation.mutate({ track, revision: playlist.revision })}
                  type="button"
                >
                  {exists ? 'Added' : 'Add'}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className={styles.dialogActions}>
        <button className={styles.secondaryButton} disabled={mutation.isPending} onClick={onClose} type="button">Done</button>
      </div>
    </ModalDialog>
  );
};
