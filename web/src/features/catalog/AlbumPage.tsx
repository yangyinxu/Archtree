import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';

import type { LibraryTarget } from '../../api/contentSchemas';
import { listenerAlbumQuery, saveStatusesQuery } from '../../api/listener';
import { browserSessionQuery } from '../../api/session';
import { Artwork } from '../../components/Artwork';
import { Icon } from '../../components/Icon';
import { SaveButton } from '../../components/SaveButton';
import { launchAlbumPlayback } from '../playback/launchPlayback';
import styles from './CatalogPages.module.css';

const releaseLabel = (year?: number) => year ? String(year) : 'Album';

/** Renders one expanded Album and launches its canonical ready-only queue. */
export const AlbumPage = () => {
  const { albumId = '' } = useParams();
  const session = useQuery(browserSessionQuery());
  const viewerId = session.data?.user.id;
  const albumQuery = useQuery(listenerAlbumQuery(albumId));
  const [savedOverrides, setSavedOverrides] = useState<Record<string, boolean>>({});
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
    return savedOverrides[key] ?? savedByKey.get(key) ?? null;
  };
  const setSaved = (target: LibraryTarget, saved: boolean) => {
    const key = `${target.contentType}:${target.contentId}`;
    setSavedOverrides((current) => ({ ...current, [key]: saved }));
  };

  if (albumQuery.isPending) {
    return <div className={styles.page}><div className={styles.state} aria-busy="true">Loading Album…</div></div>;
  }
  if (albumQuery.isError) {
    return (
      <div className={styles.page}>
        <div className={styles.state} role="alert">
          <h1>This Album is unavailable</h1>
          <p>It may have moved, or the catalog may be temporarily out of reach.</p>
          <button onClick={() => albumQuery.refetch()} type="button">Try again</button>
        </div>
      </div>
    );
  }

  const { album, tracks } = albumQuery.data;
  const albumTarget: LibraryTarget = { contentType: 'album', contentId: album.id };

  return (
    <div className={styles.page}>
      <header className={styles.hero}>
        <Artwork
          alt={`${album.title} cover`}
          className={styles.heroArtwork}
          fetchPriority="high"
          kind="album"
          loading="eager"
          sizes="(max-width: 520px) 12rem, (max-width: 720px) 10rem, 20rem"
          src={album.artworkUrl}
        />
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}>Album</p>
          <h1>{album.title || 'Untitled album'}</h1>
          <p className={styles.metadata}>
            {[album.artistNames.join(', '), releaseLabel(album.releaseDate?.year), `${tracks.length} soundtrack${tracks.length === 1 ? '' : 's'}`]
              .filter(Boolean)
              .join(' · ')}
          </p>
          <div className={styles.actions}>
            <button
              className={styles.playButton}
              disabled={tracks.length === 0}
              onClick={() => { void launchAlbumPlayback(album.id, tracks, viewerId); }}
              type="button"
            >
              <Icon name="play" />
              Play
            </button>
            <SaveButton
              onSavedChange={(saved) => setSaved(albumTarget, saved)}
              saved={savedFor(albumTarget)}
              target={albumTarget}
              viewerId={viewerId}
            />
          </div>
        </div>
      </header>

      <section className={styles.trackSection} aria-labelledby="album-soundtracks-title">
        <div className={styles.sectionHeader}>
          <div>
            <p className={styles.eyebrow}>In this Album</p>
            <h2 id="album-soundtracks-title">Soundtracks</h2>
          </div>
          <p>{tracks.length > 0 ? 'Select any row to begin from that soundtrack.' : 'No playable soundtracks are linked yet.'}</p>
        </div>
        {tracks.length > 0 ? (
          <ol className={styles.trackList}>
            {tracks.map((track, index) => {
              const target: LibraryTarget = { contentType: 'audioTrack', contentId: track.id };
              return (
                <li className={styles.trackRow} key={track.id}>
                  <button
                    aria-label={`Play ${track.title || 'Untitled soundtrack'}`}
                    className={styles.trackAction}
                    onClick={() => { void launchAlbumPlayback(album.id, tracks, viewerId, track.id); }}
                    type="button"
                  >
                    <span className={styles.trackNumber}>{index + 1}</span>
                    <span className={styles.trackCopy}>
                      <span className={styles.trackTitle}>{track.title || 'Untitled soundtrack'}</span>
                      <span className={styles.trackMeta}>{track.artistNames.join(', ') || album.title}</span>
                    </span>
                    <span className={styles.duration}>{track.duration || ''}</span>
                  </button>
                  <SaveButton
                    compact
                    onSavedChange={(saved) => setSaved(target, saved)}
                    saved={savedFor(target)}
                    target={target}
                    viewerId={viewerId}
                  />
                </li>
              );
            })}
          </ol>
        ) : (
          <div className={styles.empty}>There is nothing playable in this Album right now.</div>
        )}
      </section>
    </div>
  );
};
