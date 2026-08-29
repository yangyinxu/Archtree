import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AudioLines } from 'lucide-react';
import { Link, useParams } from 'react-router';

import type { LibraryTarget } from '../../api/contentSchemas';
import { listenerAlbumQuery, saveStatusesQuery } from '../../api/listener';
import { contentByline } from '../../api/contentSchemas';
import { browserSessionQuery } from '../../api/session';
import { Artwork } from '../../components/Artwork';
import { Icon } from '../../components/Icon';
import { SaveButton } from '../../components/SaveButton';
import { launchAlbumPlayback } from '../playback/launchPlayback';
import { AddTrackToPlaylistButton } from '../playlists/AddTrackToPlaylistButton';
import styles from './CatalogPages.module.css';
import { useLocalization } from '../../localization/LocalizationProvider';
import type { MessageKey } from '../../localization/contract';
import { playerStore } from '../../player';

const creditRoleKeys: Record<string, MessageKey> = {
  primary: 'catalog.credit.primary',
  featured: 'catalog.credit.featured',
  performer: 'catalog.credit.performer',
  composer: 'catalog.credit.composer',
  producer: 'catalog.credit.producer',
  remixer: 'catalog.credit.remixer',
  label: 'catalog.credit.label',
  publisher: 'catalog.credit.publisher',
  distributor: 'catalog.credit.distributor',
  presenter: 'catalog.credit.presenter',
  legacyUnspecified: 'catalog.credit.credit'
};

const readPlayingTrackId = () => {
  const snapshot = playerStore.getSnapshot();
  return snapshot.status === 'playing' ? snapshot.currentItem?.id ?? null : null;
};

const readServerPlayingTrackId = () => {
  const snapshot = playerStore.getServerSnapshot();
  return snapshot.status === 'playing' ? snapshot.currentItem?.id ?? null : null;
};

/** Subscribes Album rows to playback identity without repainting on every clock tick. */
const usePlayingTrackId = () => useSyncExternalStore(
  playerStore.subscribe,
  readPlayingTrackId,
  readServerPlayingTrackId
);

/** Renders one expanded Album and launches its canonical ready-only queue. */
export const AlbumPage = () => {
  const { t } = useLocalization();
  const playingTrackId = usePlayingTrackId();
  const { albumId = '' } = useParams();
  const session = useQuery(browserSessionQuery());
  const viewerId = session.data?.user.id;
  const albumQuery = useQuery(listenerAlbumQuery(albumId));
  const overrideOwner = `${viewerId ?? 'signed-out'}:${albumId}`;
  const [savedOverrides, setSavedOverrides] = useState<{
    owner: string;
    values: Record<string, boolean>;
  }>({ owner: overrideOwner, values: {} });
  useEffect(() => setSavedOverrides({ owner: overrideOwner, values: {} }), [overrideOwner]);
  const currentOverrides = savedOverrides.owner === overrideOwner ? savedOverrides.values : {};
  const targets = useMemo<LibraryTarget[]>(() => {
    if (!albumQuery.data) return [];
    return [
      { contentType: 'album', contentId: albumQuery.data.album.id },
      ...albumQuery.data.tracks.map((track) => ({
        contentType: 'audioTrack' as const,
        contentId: track.id
      }))
    ];
  }, [albumQuery.data]);
  const statuses = useQuery(saveStatusesQuery(viewerId ?? '', targets));
  const savedByKey = useMemo(() => new Map(
    statuses.data?.items.map((item) => [`${item.contentType}:${item.contentId}`, item.saved]) ?? []
  ), [statuses.data]);
  const savedFor = (target: LibraryTarget) => {
    if (!viewerId) return false;
    const key = `${target.contentType}:${target.contentId}`;
    return currentOverrides[key] ?? savedByKey.get(key) ?? null;
  };
  const setSaved = (target: LibraryTarget, saved: boolean) => {
    const key = `${target.contentType}:${target.contentId}`;
    setSavedOverrides((current) => ({
      owner: overrideOwner,
      values: {
        ...(current.owner === overrideOwner ? current.values : {}),
        [key]: saved
      }
    }));
  };

  if (albumQuery.isPending) {
    return <div className={styles.page}><div className={styles.state} aria-busy="true">{t('catalog.album.loading')}</div></div>;
  }
  if (albumQuery.isError) {
    return (
      <div className={styles.page}>
        <div className={styles.state} role="alert">
          <h1>{t('catalog.album.unavailable')}</h1>
          <p>{t('catalog.error.copy')}</p>
          <button onClick={() => albumQuery.refetch()} type="button">{t('common.action.try_again')}</button>
        </div>
      </div>
    );
  }

  const { album, tracks } = albumQuery.data;
  const albumTarget: LibraryTarget = { contentType: 'album', contentId: album.id };

  return (
    <div className={`${styles.page} ${styles.albumPage}`}>
      <header className={styles.albumHeroBlock}>
        <div className={styles.hero}>
          <Artwork
            alt={t('content.album.cover_alt', { title: album.title })}
            className={styles.heroArtwork}
            fetchPriority="high"
            kind="album"
            loading="eager"
            sizes="(max-width: 520px) 12rem, (max-width: 720px) 10rem, 20rem"
            src={album.artworkUrl}
          />
          <div className={styles.heroCopy}>
            <p className={styles.eyebrow}>{t('common.label.album')}</p>
            <h1>{album.title || t('content.title.untitled_album')}</h1>
            <p className={styles.metadata}>
              {[contentByline(album), album.releaseDate?.year
                ? String(album.releaseDate.year)
                : t('common.label.album'), t('catalog.album.track_count', { count: tracks.length })]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </div>
        </div>
        <div className={`${styles.actions} ${styles.albumActions}`}>
          <button
            aria-label={t('common.action.play')}
            className={styles.playButton}
            disabled={tracks.length === 0}
            onClick={() => { void launchAlbumPlayback(album.id, tracks, viewerId); }}
            type="button"
          >
            <Icon name="play" />
            <span className={styles.playLabel}>{t('common.action.play')}</span>
          </button>
          <SaveButton
            compact
            onSavedChange={(saved) => setSaved(albumTarget, saved)}
            saved={savedFor(albumTarget)}
            target={albumTarget}
            viewerId={viewerId}
          />
        </div>
      </header>

      {(album.credits?.length ?? 0) > 0 && (
        <section className={styles.creditSection} aria-labelledby="album-credits-title">
          <div className={styles.sectionHeader}>
            <div>
              <p className={styles.eyebrow}>{t('catalog.album.attribution')}</p>
              <h2 id="album-credits-title">{t('common.label.credits')}</h2>
            </div>
          </div>
          <ul className={styles.creditList}>
            {album.credits?.map((credit) => (
              <li key={`${credit.subjectType}:${credit.subjectId}:${credit.role}`}>
                <Link to={`/${credit.subjectType === 'artist' ? 'artists' : 'organizations'}/${encodeURIComponent(credit.subjectId)}`}>
                  <span>{credit.name}</span>
                  <small>{t(creditRoleKeys[credit.role] ?? 'catalog.credit.credit')}</small>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className={styles.trackSection} aria-labelledby="album-soundtracks-title">
        <div className={styles.sectionHeader}>
          <div>
            <p className={styles.eyebrow}>{t('catalog.album.in_album')}</p>
            <h2 id="album-soundtracks-title">{t('common.label.mediatracks')}</h2>
          </div>
          <p>{tracks.length > 0 ? t('catalog.album.select_track') : t('catalog.album.no_tracks')}</p>
        </div>
        {tracks.length > 0 ? (
          <ol className={styles.trackList}>
            {tracks.map((track, index) => {
              const target: LibraryTarget = { contentType: 'audioTrack', contentId: track.id };
              const title = track.title || t('content.title.untitled_track');
              const isPlaying = playingTrackId === track.id;
              return (
                <li
                  className={styles.trackRow}
                  data-playback-state={isPlaying ? 'playing' : undefined}
                  key={track.id}
                >
                  <button
                    aria-current={isPlaying ? 'true' : undefined}
                    aria-label={isPlaying
                      ? t('player.action.pause')
                      : t('content.play.label', { title })}
                    className={styles.trackAction}
                    onClick={() => {
                      if (isPlaying) {
                        playerStore.pause();
                        return;
                      }
                      void launchAlbumPlayback(album.id, tracks, viewerId, track.id);
                    }}
                    type="button"
                  >
                    <span aria-hidden="true" className={styles.trackNumber}>
                      {isPlaying ? (
                        <span className={styles.trackPlaybackIndicator}>
                          <AudioLines
                            aria-hidden="true"
                            className={styles.trackPlaybackBars}
                            focusable="false"
                            strokeWidth={1.9}
                          />
                          <Icon className={styles.trackPauseIcon} name="pause" />
                        </span>
                      ) : index + 1}
                    </span>
                    <span className={styles.trackCopy}>
                      <span className={`${styles.trackTitle} ${isPlaying ? styles.trackTitlePlaying : ''}`}>
                        {title}
                      </span>
                      <span className={styles.trackMeta}>{contentByline(track) || album.title}</span>
                    </span>
                    <span className={styles.duration}>{track.duration || ''}</span>
                  </button>
                  <span className={styles.trackTrailing}>
                    <AddTrackToPlaylistButton
                      accountPending={session.isPending}
                      accountUnavailable={session.isError}
                      track={track}
                      viewerId={viewerId}
                    />
                    <SaveButton
                      compact
                      onSavedChange={(saved) => setSaved(target, saved)}
                      saved={savedFor(target)}
                      target={target}
                      viewerId={viewerId}
                    />
                  </span>
                </li>
              );
            })}
          </ol>
        ) : (
          <div className={styles.empty}>{t('catalog.album.empty')}</div>
        )}
      </section>
    </div>
  );
};
