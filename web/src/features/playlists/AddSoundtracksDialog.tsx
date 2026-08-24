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
import {
  useLocalization,
  type LocalizationContextValue
} from '../../localization/LocalizationProvider';

const addErrorMessage = (error: unknown, t: LocalizationContextValue['t']) => {
  if (!(error instanceof ApiError)) return t('playlist.error.add_unconfirmed');
  if (error.code === 'playlist_item_limit_reached') return t('playlist.error.item_limit_this');
  if (error.code === 'idempotency_in_progress') {
    return t('playlist.error.add_pending_track');
  }
  if (error.code === 'idempotency_key_reused') {
    return t('playlist.error.add_retry_mismatch');
  }
  if (error.code === 'account_viewer_mismatch' || error.status === 401) {
    return t('playlist.error.account_add_track');
  }
  if (error.code === 'playlist_revision_conflict' || error.status === 409) {
    return t('playlist.error.revision_this_loading');
  }
  if (error.code === 'audio_track_not_found' || error.status === 404) {
    return t('playlist.error.track_not_ready');
  }
  return t('playlist.error.add_unconfirmed');
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
  const { t } = useLocalization();
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
      setMessage(t('playlist.add.added_message', {
        title: variables.track.title || t('content.title.untitled_track')
      }));
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
      description={t('playlist.add.description')}
      initialFocusRef={inputRef}
      kicker={playlist.name}
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      title={t('playlist.add.title')}
      wide
    >
      <form className={styles.pickerSearch} onSubmit={submit} role="search">
        <label className="visually-hidden" htmlFor="playlist-soundtrack-search">{t('playlist.add.search_label')}</label>
        <input
          id="playlist-soundtrack-search"
          onChange={(event) => setDraft(event.currentTarget.value)}
          placeholder={t('playlist.add.search_placeholder')}
          ref={inputRef}
          type="search"
          value={draft}
        />
        <button className={styles.secondaryButton} type="submit">{t('common.action.search')}</button>
      </form>

      {ownsLocalState && message && <p aria-live="polite" className={styles.feedbackSuccess}>{message}</p>}
      {ownsLocalState && mutation.isError && <p className={styles.feedbackError} role="alert">{addErrorMessage(mutation.error, t)}</p>}

      {!query ? (
        <p className={styles.pickerState}>{t('playlist.add.empty')}</p>
      ) : results.isPending ? (
        <p aria-busy="true" className={styles.pickerState}>{t('playlist.add.searching')}</p>
      ) : results.isError ? (
        <div className={styles.pickerState} role="alert">
          <span>{t('playlist.add.search_error')}</span>
          <button className={styles.textButton} onClick={() => results.refetch()} type="button">{t('common.action.try_again')}</button>
        </div>
      ) : results.data.audioTracks.length === 0 ? (
        <p className={styles.pickerState}>{t('playlist.add.no_results', { query })}</p>
      ) : (
        <ul className={styles.pickerResults} aria-label={t('playlist.add.results_label', { query })}>
          {results.data.audioTracks.map((track) => {
            const exists = existingIds.has(track.id);
            return (
              <li key={track.id}>
                <Artwork alt="" className={styles.pickerArtwork} kind="audioTrack" sizes="3rem" src={track.artworkUrl} />
                <span className={styles.pickerCopy}>
                  <span title={track.title || t('content.title.untitled_track')}>{track.title || t('content.title.untitled_track')}</span>
                  <span>{contentByline(track) || track.albumTitle || t('common.label.mediatrack')}</span>
                </span>
                <button
                  aria-label={exists
                    ? t('playlist.add.existing_label', {
                        title: track.title || t('content.title.untitled_track'),
                        playlist: playlist.name
                      })
                    : t('playlist.add.label', {
                        title: track.title || t('content.title.untitled_track'),
                        playlist: playlist.name
                      })}
                  className={styles.secondaryButton}
                  disabled={exists || mutation.isPending || playlist.itemCount >= 500}
                  onClick={() => mutation.mutate({ track, revision: playlist.revision })}
                  type="button"
                >
                  {exists ? t('playlist.add.added') : t('playlist.action.add')}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className={styles.dialogActions}>
        <button className={styles.secondaryButton} disabled={mutation.isPending} onClick={onClose} type="button">{t('common.action.done')}</button>
      </div>
    </ModalDialog>
  );
};
