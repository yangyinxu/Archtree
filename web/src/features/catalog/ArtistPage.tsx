import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';

import { listenerArtistQuery } from '../../api/listener';
import { browserSessionQuery } from '../../api/session';
import { Artwork } from '../../components/Artwork';
import { PageSection } from '../../components/PageSection';
import { launchStandalonePlayback } from '../playback/launchPlayback';
import styles from './CatalogPages.module.css';
import { useLocalization } from '../../localization/LocalizationProvider';

/** Presents one Artist and its resolved releases without client-side fan-out. */
export const ArtistPage = () => {
  const { t } = useLocalization();
  const { artistId = '' } = useParams();
  const session = useQuery(browserSessionQuery());
  const artistQuery = useQuery(listenerArtistQuery(artistId));

  if (artistQuery.isPending) {
    return <div className={styles.page}><div className={styles.state} aria-busy="true">{t('catalog.artist.loading')}</div></div>;
  }
  if (artistQuery.isError) {
    return (
      <div className={styles.page}>
        <div className={styles.state} role="alert">
          <h1>{t('catalog.artist.unavailable')}</h1>
          <p>{t('catalog.error.copy')}</p>
          <button onClick={() => artistQuery.refetch()} type="button">{t('common.action.try_again')}</button>
        </div>
      </div>
    );
  }

  const { artist, albums, audioTracks } = artistQuery.data;
  const discography = artistQuery.data.discography ?? albums;
  const collaborations = artistQuery.data.collaborations ?? [];
  const appearsOn = artistQuery.data.appearsOn ?? [];
  const creditAlbums = artistQuery.data.creditAlbums ?? [];

  return (
    <div className={styles.page}>
      <header className={styles.hero}>
        <Artwork
          alt={t('content.artist.portrait_alt', { name: artist.name })}
          className={styles.artistArtwork}
          fetchPriority="high"
          kind="artist"
          loading="eager"
          sizes="(max-width: 520px) 12rem, (max-width: 720px) 10rem, 20rem"
          src={artist.artworkUrl}
        />
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}>{t('common.label.artist')}</p>
          <h1>{artist.name || t('content.title.unknown_artist')}</h1>
          {artist.bio && <p className={styles.bio}>{artist.bio}</p>}
        </div>
      </header>

      {discography.length > 0 && (
        <PageSection id={`${artist.id}-albums`} items={discography} presentation="grid" title={t('catalog.artist.section.discography')} />
      )}
      {collaborations.length > 0 && (
        <PageSection id={`${artist.id}-collaborations`} items={collaborations} presentation="grid" title={t('catalog.artist.section.collaborations')} />
      )}
      {appearsOn.length > 0 && (
        <PageSection id={`${artist.id}-appears-on`} items={appearsOn} presentation="grid" title={t('catalog.artist.section.appears_on')} />
      )}
      {creditAlbums.length > 0 && (
        <PageSection id={`${artist.id}-credits`} items={creditAlbums} presentation="grid" title={t('common.label.credits')} />
      )}
      {audioTracks.length > 0 && (
        <PageSection
          id={`${artist.id}-soundtracks`}
          items={audioTracks}
          onPlay={(track) => { void launchStandalonePlayback(track, session.data?.user.id); }}
          presentation="list"
          title={t('common.label.mediatracks')}
        />
      )}
      {discography.length === 0 && collaborations.length === 0 && appearsOn.length === 0
        && creditAlbums.length === 0 && audioTracks.length === 0 && (
        <div className={styles.empty}>{t('catalog.artist.empty')}</div>
      )}
    </div>
  );
};
