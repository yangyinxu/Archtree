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
import {
  useLocalization,
  type LocalizationContextValue
} from '../../localization/LocalizationProvider';

const playlistMutationMessage = (
  error: unknown,
  operation: 'create' | 'rename' | 'delete',
  t: LocalizationContextValue['t']
) => {
  if (!(error instanceof ApiError)) return t('playlist.error.change_unconfirmed');
  if (error.code === 'playlist_limit_reached') {
    return t('playlist.error.playlist_limit');
  }
  if (error.code === 'idempotency_in_progress') {
    return t('playlist.error.request_pending');
  }
  if (error.code === 'idempotency_key_reused') {
    return t('playlist.error.request_key_mismatch');
  }
  if (error.code === 'account_viewer_mismatch' || error.status === 401) {
    return t('playlist.error.account_changed');
  }
  if (error.code === 'playlist_revision_conflict' || error.status === 409) {
    return operation === 'create'
      ? t('playlist.error.replay_unsafe')
      : t('playlist.error.revision_loading');
  }
  if (error.status === 429) return t('playlist.error.rate_limit');
  return t('playlist.error.change_unconfirmed');
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
  const { t } = useLocalization();
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
      setValidationError(t('playlist.name.validation'));
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
        ? t('playlist.name.create_description')
        : t('playlist.name.rename_description')}
      initialFocusRef={inputRef}
      kicker={t('library.title')}
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      title={mode === 'create' ? t('playlist.name.create_title') : t('playlist.name.rename_title')}
    >
      <form className={styles.dialogForm} onSubmit={submit}>
        <label className={styles.field}>
          <span>{t('playlist.name.field')}</span>
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
        <p className={styles.fieldHint} id="playlist-name-hint">{t('playlist.name.hint')}</p>
        {(validationError || mutation.isError) && (
          <p className={styles.feedbackError} role="alert">
            {validationError || playlistMutationMessage(mutation.error, mode, t)}
          </p>
        )}
        <div className={styles.dialogActions}>
          <button className={styles.secondaryButton} disabled={mutation.isPending} onClick={onClose} type="button">{t('common.action.cancel')}</button>
          <button className={styles.primaryButton} disabled={mutation.isPending} type="submit">
            {mutation.isPending
              ? t('playlist.name.saving')
              : mode === 'create'
                ? t('playlist.action.create')
                : t('playlist.action.save_name')}
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
  const { t } = useLocalization();
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
      description={t('playlist.delete.description', { name: playlist.name })}
      initialFocusRef={cancelRef}
      kicker={t('playlist.delete.kicker')}
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      title={t('playlist.delete.title')}
    >
      {mutation.isError && (
        <p className={styles.feedbackError} role="alert">
          {playlistMutationMessage(mutation.error, 'delete', t)}
        </p>
      )}
      <div className={styles.dialogActions}>
        <button className={styles.secondaryButton} disabled={mutation.isPending} onClick={onClose} ref={cancelRef} type="button">{t('common.action.cancel')}</button>
        <button className={styles.dangerButton} disabled={mutation.isPending} onClick={() => mutation.mutate()} type="button">
          {mutation.isPending ? t('playlist.delete.deleting') : t('playlist.action.delete')}
        </button>
      </div>
    </ModalDialog>
  );
};
