import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';

import { listenerArtistQuery } from '../../api/listener';
import { browserSessionQuery } from '../../api/session';
import { Artwork } from '../../components/Artwork';
import { PageSection } from '../../components/PageSection';
import { launchStandalonePlayback } from '../playback/launchPlayback';
import styles from './CatalogPages.module.css';

/** Presents one Artist and its resolved releases without client-side fan-out. */
export const ArtistPage = () => {
  const { artistId = '' } = useParams();
  const session = useQuery(browserSessionQuery());
  const artistQuery = useQuery(listenerArtistQuery(artistId));

  if (artistQuery.isPending) {
    return <div className={styles.page}><div className={styles.state} aria-busy="true">Loading Artist…</div></div>;
  }
  if (artistQuery.isError) {
    return (
      <div className={styles.page}>
        <div className={styles.state} role="alert">
          <h1>This Artist is unavailable</h1>
          <p>It may have moved, or the catalog may be temporarily out of reach.</p>
          <button onClick={() => artistQuery.refetch()} type="button">Try again</button>
        </div>
      </div>
    );
  }

  const { artist, albums, audioTracks } = artistQuery.data;

  return (
    <div className={styles.page}>
      <header className={styles.hero}>
        <Artwork
          alt={`${artist.name} portrait`}
          className={styles.artistArtwork}
          fetchPriority="high"
          kind="artist"
          loading="eager"
          sizes="(max-width: 520px) 12rem, (max-width: 720px) 10rem, 20rem"
          src={artist.artworkUrl}
        />
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}>Artist</p>
          <h1>{artist.name || 'Unknown artist'}</h1>
          {artist.bio && <p className={styles.bio}>{artist.bio}</p>}
        </div>
      </header>

      {albums.length > 0 && (
        <PageSection id={`${artist.id}-albums`} items={albums} presentation="grid" title="Albums" />
      )}
      {audioTracks.length > 0 && (
        <PageSection
          id={`${artist.id}-soundtracks`}
          items={audioTracks}
          onPlay={(track) => { void launchStandalonePlayback(track, session.data?.user.id); }}
          presentation="list"
          title="Soundtracks"
        />
      )}
      {albums.length === 0 && audioTracks.length === 0 && (
        <div className={styles.empty}>No public releases are available for this Artist yet.</div>
      )}
    </div>
  );
};
