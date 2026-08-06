import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type RefObject
} from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { ApiError } from '../../api/client';
import { captureAccountOperation, isAccountOperationCurrent } from '../../api/accountEpoch';
import {
  createPlaylist,
  createPlaylistIdempotencyKey,
  deletePlaylist,
  playlistNameSchema,
  playlistQueryKeys,
  renamePlaylist,
  type PlaylistSummary
} from '../../api/playlists';
import { ModalDialog } from '../../components/ModalDialog';
import {
  commitPlaylistDetail,
  removePlaylistFromCaches,
  revalidatePlaylistLists
} from './playlistCache';
import styles from './Playlists.module.css';

const playlistMutationMessage = (error: unknown, operation: 'create' | 'rename' | 'delete') => {
  if (!(error instanceof ApiError)) return 'Finitude could not confirm that Playlist change.';
  if (error.code === 'playlist_limit_reached') {
    return 'You already have 100 Playlists. Delete one before creating another.';
  }
  if (error.code === 'idempotency_in_progress') {
    return 'That Playlist request is still being confirmed. Wait a moment, then retry this same action.';
  }
  if (error.code === 'idempotency_key_reused') {
    return 'That request key no longer matches this change. Close the dialog and start the action again.';
  }
  if (error.code === 'account_viewer_mismatch' || error.status === 401) {
    return 'Your signed-in account changed. Reload the page before trying again.';
  }
  if (error.code === 'playlist_revision_conflict' || error.status === 409) {
    return operation === 'create'
      ? 'That request could not be replayed safely. Close this dialog and try again.'
      : 'This Playlist changed on another device. Finitude is loading the newest version.';
  }
  if (error.status === 429) return 'Too many Playlist requests were sent. Wait a moment and try again.';
  return error.message;
};

interface PlaylistNameDialogProps {
  mode: 'create' | 'rename';
  viewerId: string;
  playlist?: PlaylistSummary;
  onClose: () => void;
  onConfirmed: (playlistId: string) => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}

/** Reuses one validated name flow for creation and revision-checked renaming. */
export const PlaylistNameDialog = ({
  mode,
  viewerId,
  playlist,
  onClose,
  onConfirmed,
  returnFocusRef
}: PlaylistNameDialogProps) => {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const submittedRef = useRef<{ name: string; key: string } | null>(null);
  const [name, setName] = useState(playlist?.name ?? '');
  const [validationError, setValidationError] = useState('');
  const mutation = useMutation({
    mutationFn: ({ normalizedName, key }: { normalizedName: string; key: string }) => mode === 'create'
      ? createPlaylist({ viewerId, name: normalizedName, idempotencyKey: key })
      : renamePlaylist({
          viewerId,
          playlistId: playlist!.id,
          revision: playlist!.revision,
          name: normalizedName,
          idempotencyKey: key
        }),
    onMutate: () => captureAccountOperation(viewerId),
    onSuccess: (detail, _variables, guard) => {
      if (!guard || !isAccountOperationCurrent(guard, viewerId)) return;
      commitPlaylistDetail(queryClient, viewerId, detail, guard);
      void revalidatePlaylistLists(queryClient, viewerId, guard);
      onConfirmed(detail.id);
    },
    onError: (error, _variables, guard) => {
      if (!guard || !isAccountOperationCurrent(guard, viewerId)) return;
      if (playlist && error instanceof ApiError && error.status === 409) {
        if (error.code !== 'idempotency_in_progress') submittedRef.current = null;
        void queryClient.invalidateQueries({
          queryKey: playlistQueryKeys.detail(viewerId, playlist.id),
          exact: true
        });
        void revalidatePlaylistLists(queryClient, viewerId, guard);
      }
    }
  });

  useEffect(() => {
    submittedRef.current = null;
    setValidationError('');
    setName(playlist?.name ?? '');
    mutation.reset();
  }, [playlist?.id, viewerId]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsed = playlistNameSchema.safeParse(name);
    if (!parsed.success) {
      setValidationError('Enter a name between 1 and 100 characters.');
      inputRef.current?.focus();
      return;
    }
    setValidationError('');
    const existing = submittedRef.current;
    const key = existing?.name === parsed.data
      ? existing.key
      : createPlaylistIdempotencyKey();
    submittedRef.current = { name: parsed.data, key };
    mutation.mutate({ normalizedName: parsed.data, key });
  };

  return (
    <ModalDialog
      closeDisabled={mutation.isPending}
      description={mode === 'create'
        ? 'Playlist names can be reused and changed later.'
        : 'Only the name changes; saved music and the active playback queue stay as they are.'}
      initialFocusRef={inputRef}
      kicker="Your Library"
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      title={mode === 'create' ? 'Create a Playlist' : 'Rename Playlist'}
    >
      <form className={styles.dialogForm} onSubmit={submit}>
        <label className={styles.field}>
          <span>Name</span>
          <input
            aria-describedby="playlist-name-hint"
            aria-busy={mutation.isPending}
            autoComplete="off"
            onChange={(event) => {
              setName(event.currentTarget.value);
              setValidationError('');
              mutation.reset();
            }}
            ref={inputRef}
            readOnly={mutation.isPending}
            value={name}
          />
        </label>
        <p className={styles.fieldHint} id="playlist-name-hint">1–100 characters</p>
        {(validationError || mutation.isError) && (
          <p className={styles.feedbackError} role="alert">
            {validationError || playlistMutationMessage(mutation.error, mode)}
          </p>
        )}
        <div className={styles.dialogActions}>
          <button className={styles.secondaryButton} disabled={mutation.isPending} onClick={onClose} type="button">Cancel</button>
          <button className={styles.primaryButton} disabled={mutation.isPending} type="submit">
            {mutation.isPending ? 'Saving…' : mode === 'create' ? 'Create Playlist' : 'Save name'}
          </button>
        </div>
      </form>
    </ModalDialog>
  );
};

export const PlaylistDeleteDialog = ({
  viewerId,
  playlist,
  onClose,
  onDeleted,
  returnFocusRef
}: {
  viewerId: string;
  playlist: PlaylistSummary;
  onClose: () => void;
  onDeleted: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}) => {
  const queryClient = useQueryClient();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const idempotencyKeyRef = useRef('');
  const mutation = useMutation({
    mutationFn: () => {
      idempotencyKeyRef.current ||= createPlaylistIdempotencyKey();
      return deletePlaylist({
        viewerId,
        playlistId: playlist.id,
        revision: playlist.revision,
        idempotencyKey: idempotencyKeyRef.current
      });
    },
    onMutate: async () => {
      const guard = captureAccountOperation(viewerId);
      await queryClient.cancelQueries({
        queryKey: playlistQueryKeys.detail(viewerId, playlist.id),
        exact: true
      });
      return guard;
    },
    onSuccess: (_result, _variables, guard) => {
      if (!isAccountOperationCurrent(guard, viewerId)) return;
      removePlaylistFromCaches(queryClient, viewerId, playlist.id, guard);
      void revalidatePlaylistLists(queryClient, viewerId, guard);
      onDeleted();
    },
    onError: (error, _variables, guard) => {
      if (!guard || !isAccountOperationCurrent(guard, viewerId)) return;
      if (error instanceof ApiError && error.status === 409) {
        if (error.code !== 'idempotency_in_progress') idempotencyKeyRef.current = '';
        void queryClient.invalidateQueries({
          queryKey: playlistQueryKeys.detail(viewerId, playlist.id),
          exact: true
        });
        void revalidatePlaylistLists(queryClient, viewerId, guard);
      }
    }
  });

  return (
    <ModalDialog
      closeDisabled={mutation.isPending}
      description={`“${playlist.name}” will disappear, but its Soundtracks, Saved Library state, and anything already playing will stay unchanged.`}
      initialFocusRef={cancelRef}
      kicker="Permanent action"
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      title="Delete this Playlist?"
    >
      {mutation.isError && (
        <p className={styles.feedbackError} role="alert">
          {playlistMutationMessage(mutation.error, 'delete')}
        </p>
      )}
      <div className={styles.dialogActions}>
        <button className={styles.secondaryButton} disabled={mutation.isPending} onClick={onClose} ref={cancelRef} type="button">Cancel</button>
        <button className={styles.dangerButton} disabled={mutation.isPending} onClick={() => mutation.mutate()} type="button">
          {mutation.isPending ? 'Deleting…' : 'Delete Playlist'}
        </button>
      </div>
    </ModalDialog>
  );
};
