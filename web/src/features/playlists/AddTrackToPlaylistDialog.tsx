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
import {
  useLocalization,
  type LocalizationContextValue
} from '../../localization/LocalizationProvider';

const addFailureMessage = (error: unknown, t: LocalizationContextValue['t']) => {
  if (!(error instanceof ApiError)) return t('playlist.error.add_unconfirmed');
  if (error.code === 'playlist_item_limit_reached') return t('playlist.error.item_limit_that');
  if (error.code === 'idempotency_in_progress') return t('playlist.error.add_pending');
  if (error.code === 'idempotency_key_reused') return t('playlist.error.add_retry_mismatch');
  if (error.code === 'account_viewer_mismatch' || error.status === 401) {
    return t('playlist.error.account_add_this');
  }
  if (error.code === 'playlist_revision_conflict' || error.status === 409) {
    return t('playlist.error.revision_that_loading');
  }
  return t('playlist.error.add_unconfirmed');
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
  const { t } = useLocalization();
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
      description={t('playlist.add_one.choose_description', {
        title: track.title || t('content.title.untitled_track')
      })}
      initialFocusRef={closeRef}
      kicker={t('playlist.add_one.button_title')}
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      title={t('playlist.add_one.choose_title')}
    >
      {ownsLocalState && mutation.isError && <p className={playlistStyles.feedbackError} role="alert">{addFailureMessage(mutation.error, t)}</p>}
      {memberships.isError && (
        <p className={playlistStyles.feedbackError} role="alert">
          {t('playlist.add_one.membership_error')}
        </p>
      )}
      {playlists.isPending ? (
        <p aria-busy="true" className={styles.state}>{t('playlist.add_one.loading')}</p>
      ) : playlists.isError ? (
        <div className={styles.state} role="alert">
          <span>{t('playlist.index.load_error')}</span>
          <button className={playlistStyles.textButton} onClick={() => playlists.refetch()} type="button">{t('common.action.try_again')}</button>
        </div>
      ) : playlists.data.items.length === 0 ? (
        <div className={styles.state}>
          <span>{t('playlist.add_one.empty')}</span>
          <Link className={playlistStyles.primaryButton} onClick={onClose} to="/playlists">{t('playlist.action.create')}</Link>
        </div>
      ) : (
        <ul aria-label={t('playlist.add_one.choose_title')} className={styles.list}>
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
                    <span>{t('common.label.playlist')} · {t('playlist.item_count', { count: playlist.itemCount })}</span>
                  </span>
                </span>
                <button
                  aria-label={checkingMembership
                    ? t('playlist.add_one.checking_label', {
                        title: track.title || t('content.title.untitled_track'),
                        playlist: playlist.name
                      })
                    : alreadyAdded
                    ? t('playlist.add.existing_label', {
                        title: track.title || t('content.title.untitled_track'),
                        playlist: playlist.name
                      })
                    : playlist.itemCount >= 500
                      ? t('playlist.add_one.full_label', { playlist: playlist.name })
                      : t('playlist.add.label', {
                          title: track.title || t('content.title.untitled_track'),
                          playlist: playlist.name
                        })}
                  className={playlistStyles.secondaryButton}
                  disabled={checkingMembership || Boolean(alreadyAdded) || playlist.itemCount >= 500 || mutation.isPending}
                  onClick={() => mutation.mutate(playlist)}
                  type="button"
                >
                  {checkingMembership
                    ? t('playlist.add_one.checking')
                    : alreadyAdded
                      ? t('playlist.add.added')
                      : playlist.itemCount >= 500
                        ? t('playlist.add_one.full')
                        : t('playlist.action.add')}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className={playlistStyles.dialogActions}>
        <Link className={playlistStyles.textButton} onClick={onClose} to="/playlists">{t('playlist.action.manage')}</Link>
        <button className={playlistStyles.secondaryButton} disabled={mutation.isPending} onClick={onClose} ref={closeRef} type="button">{t('common.action.done')}</button>
      </div>
    </ModalDialog>
  );
};

export default AddTrackToPlaylistDialog;
