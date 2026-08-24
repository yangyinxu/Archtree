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
import { Artwork } from '../../components/Artwork';
import { launchPlaylistPlayback } from '../playback/launchPlayback';
import {
  commitPlaylistDetail,
  playlistSummaryFromDetail,
  revalidatePlaylistLists
} from './playlistCache';
import styles from './Playlists.module.css';
import {
  useLocalization,
  type LocalizationContextValue
} from '../../localization/LocalizationProvider';

const AddSoundtracksDialog = lazy(() => import('./AddSoundtracksDialog').then((module) => ({
  default: module.AddSoundtracksDialog
})));
const ActionMenu = lazy(() => import('../../components/ActionMenu').then((module) => ({
  default: module.ActionMenu
})));
const PlaylistDeleteDialog = lazy(() => import('./PlaylistDialogs').then((module) => ({
  default: module.PlaylistDeleteDialog
})));
const PlaylistNameDialog = lazy(() => import('./PlaylistDialogs').then((module) => ({
  default: module.PlaylistNameDialog
})));

const durationSeconds = (duration: string | null) => {
  if (!duration) return null;
  const parts = duration.split(':').map(Number);
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !Number.isFinite(part) || part < 0)) {
    return null;
  }
  return parts.reduce((total, part) => total * 60 + part, 0);
};

const memberMutationMessage = (error: unknown, t: LocalizationContextValue['t']) => {
  if (!(error instanceof ApiError)) return t('playlist.error.change_unconfirmed');
  if (error.code === 'idempotency_in_progress') {
    return t('playlist.error.member_pending');
  }
  if (error.code === 'idempotency_key_reused') {
    return t('playlist.error.member_retry_mismatch');
  }
  if (error.code === 'account_viewer_mismatch' || error.status === 401) {
    return t('playlist.error.member_account_changed');
  }
  if (error.code === 'playlist_revision_conflict' || error.status === 409) {
    return t('playlist.error.member_revision');
  }
  if (error.code === 'playlist_item_not_found' || error.status === 404) {
    return t('playlist.error.member_missing');
  }
  return t('playlist.error.change_unconfirmed');
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
  const { t } = useLocalization();
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
    setFeedback({ kind: 'error', message: memberMutationMessage(error, t) });
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
      setFeedback({ kind: 'success', message: t('playlist.detail.removed') });
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
      setMovementAnnouncement(t('playlist.detail.move_failed'));
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
    const title = playlist.items[index].audioTrack?.title || t('playlist.detail.unavailable_title');
    const signature = `order:${playlist.revision}:${order.join(',')}`;
    const idempotencyKey = mutationKeysRef.current.get(signature) ?? createPlaylistIdempotencyKey();
    mutationKeysRef.current.set(signature, idempotencyKey);
    reorderMutation.mutate({
      itemIds: order,
      revision: playlist.revision,
      idempotencyKey,
      signature,
      announcement: t('playlist.detail.moved', {
        title,
        position: destination + 1,
        count: order.length
      })
    });
  };

  if (session.isPending) {
    return <div className={styles.page}><div aria-busy="true" className={styles.state}>{t('playlist.index.checking_account')}</div></div>;
  }
  if (session.isError) {
    return (
      <div className={styles.page}><div className={styles.state} role="alert">
        <h1>{t('playlist.index.account_error_title')}</h1>
        <button className={styles.secondaryButton} onClick={() => session.refetch()} type="button">{t('common.action.try_again')}</button>
      </div></div>
    );
  }
  if (!session.data) {
    return (
      <div className={styles.page}><div className={styles.state}>
        <ListMusic aria-hidden="true" />
        <h1>{t('playlist.detail.signed_out_title')}</h1>
        <p>{t('playlist.detail.signed_out_copy')}</p>
        <Link className={styles.primaryButton} state={{ from: `/playlists/${playlistId}` }} to="/login">{t('common.action.log_in')}</Link>
      </div></div>
    );
  }
  if (playlistQuery.isPending) {
    return <div className={styles.page}><div aria-busy="true" className={styles.state}>{t('playlist.detail.opening')}</div></div>;
  }
  if (playlistQuery.isError) {
    const notFound = playlistQuery.error instanceof ApiError && playlistQuery.error.status === 404;
    return (
      <div className={styles.page}><div className={styles.state} role={notFound ? undefined : 'alert'}>
        <ListMusic aria-hidden="true" />
        <h1>{notFound ? t('playlist.detail.not_found_title') : t('playlist.detail.load_error_title')}</h1>
        <p>{notFound
          ? t('playlist.detail.not_found_copy')
          : t('playlist.detail.load_error_copy')}</p>
        {notFound
          ? <Link className={styles.secondaryButton} to="/playlists">{t('playlist.action.back_playlists')}</Link>
          : <button className={styles.secondaryButton} onClick={() => playlistQuery.refetch()} type="button">{t('common.action.try_again')}</button>}
      </div></div>
    );
  }
  if (!playlist) {
    return <div className={styles.page}><div aria-busy="true" className={styles.state}>{t('playlist.detail.opening')}</div></div>;
  }

  const summary = playlistSummaryFromDetail(playlist);
  const duration = knownDuration !== null && knownDuration > 0
    ? (() => {
        const hours = Math.floor(knownDuration / 3600);
        const minutes = Math.floor((knownDuration % 3600) / 60);
        return hours > 0
          ? t('playlist.duration.hours', { hours, minutes })
          : t('playlist.duration.minutes', { minutes: Math.max(1, minutes) });
      })()
    : '';

  return (
    <div className={styles.page}>
      <header className={styles.detailHeader}>
        <Artwork
          alt={t('playlist.artwork_alt', { name: playlist.name })}
          className={styles.playlistArtwork}
          fetchPriority="high"
          kind="audioTrack"
          loading="eager"
          sizes="(max-width: 640px) 9rem, 14rem"
          src={playlist.artworkUrl}
        />
        <div className={styles.detailCopy}>
          <p className={styles.eyebrow}>{t('playlist.detail.private')}</p>
          <h1 title={playlist.name}>{playlist.name}</h1>
          <p className={styles.detailMetadata}>
            {t('playlist.item_count', { count: playlist.itemCount })}
            {duration ? ` · ${duration}` : ''}
            {readyTracks.length !== playlist.itemCount
              ? ` · ${t('playlist.detail.unavailable_count', {
                  count: playlist.itemCount - readyTracks.length
                })}`
              : ''}
          </p>
          <div className={styles.detailActions}>
            <button
              aria-label={t('common.action.play')}
              className={styles.playButton}
              disabled={readyTracks.length === 0}
              onClick={() => { void launchPlaylistPlayback(readyTracks, viewerId); }}
              title={readyTracks.length === 0
                ? t('playlist.detail.play_unavailable')
                : t('playlist.detail.play_label', { name: playlist.name })}
              type="button"
            >
              <Play aria-hidden="true" fill="currentColor" focusable="false" />
            </button>
            <button className={styles.secondaryButton} disabled={mutationPending} onClick={() => setDialog('add')} ref={addTriggerRef} type="button">
              <Plus aria-hidden="true" /> {t('playlist.action.add_tracks')}
            </button>
            <button className={styles.secondaryButton} disabled={mutationPending} onClick={() => setDialog('rename')} ref={renameTriggerRef} type="button">{t('playlist.action.rename')}</button>
            <Suspense fallback={null}>
              <ActionMenu
                items={[{
                  label: t('playlist.action.delete'),
                  destructive: true,
                  disabled: mutationPending,
                  restoreFocus: false,
                  onSelect: () => setDialog('delete')
                }]}
                label={t('playlist.actions.more_for', { name: playlist.name })}
                triggerRef={moreTriggerRef}
              />
            </Suspense>
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
            <p className={styles.eyebrow}>{t('playlist.detail.in_playlist')}</p>
            <h2 id="playlist-soundtracks-title" ref={memberHeadingRef} tabIndex={-1}>{t('common.label.mediatracks')}</h2>
          </div>
          <p>{playlist.items.length > 0
            ? t('playlist.detail.items_copy')
            : t('playlist.detail.empty_copy')}</p>
        </div>
        {playlist.items.length === 0 ? (
          <div className={styles.emptyState}>
            <ListMusic aria-hidden="true" />
            <h3>{t('playlist.detail.empty_title')}</h3>
            <p>{t('playlist.detail.empty_copy')}</p>
            <button className={styles.primaryButton} onClick={() => setDialog('add')} type="button">{t('playlist.action.add_tracks')}</button>
          </div>
        ) : (
          <>
            <div aria-hidden="true" className={styles.memberTableHeader}>
              <span>#</span>
              <span className={styles.memberTitleHeading}>{t('playlist.detail.table.title')}</span>
              <span>{t('playlist.detail.table.duration')}</span>
              <span />
            </div>
            <ol aria-label={t('playlist.detail.members_label', { name: playlist.name })} className={styles.memberList}>
            {playlist.items.map((item, index) => {
              const track = item.audioTrack;
              const title = track?.title || t('playlist.detail.unavailable_title');
              return (
                <li className={`${styles.memberRow} ${!track ? styles.unavailableRow : ''}`} key={item.itemId}>
                  <button
                    aria-label={track
                      ? t('content.play.label', { title })
                      : t('playlist.detail.cannot_play', { title })}
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
                        ? [track.artistNames.join(', '), track.albumTitle].filter(Boolean).join(' · ') || t('common.label.mediatrack')
                        : t('playlist.detail.unavailable_copy')}</span>
                    </span>
                    <span className={styles.memberDuration}>{track?.duration || '—'}</span>
                  </button>
                  <span className={styles.memberMenu}>
                    <Suspense fallback={null}>
                      <ActionMenu
                        items={[
                          { label: t('playlist.action.move_up'), disabled: mutationPending || index === 0, onSelect: () => moveItem(item.itemId, -1) },
                          { label: t('playlist.action.move_down'), disabled: mutationPending || index === playlist.items.length - 1, onSelect: () => moveItem(item.itemId, 1) },
                          {
                            label: t('playlist.action.remove'),
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
                        label={t('playlist.actions.for', { name: title })}
                        triggerRef={memberActionRef(item.itemId)}
                      />
                    </Suspense>
                  </span>
                </li>
              );
            })}
            </ol>
          </>
        )}
      </section>

      {visibleDialog === 'rename' && (
        <Suspense fallback={null}>
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
        <Suspense fallback={null}>
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
        <Suspense fallback={null}>
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
