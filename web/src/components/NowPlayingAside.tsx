import { Artwork } from './Artwork';
import {
  playerStore,
  usePlayer,
  type PlayerStore
} from '../player';
import styles from './NowPlayingAside.module.css';

interface NowPlayingAsideProps {
  /** Tests and alternate shells may inject the same store boundary used by PlayerBar. */
  store?: PlayerStore;
}

const artistLabel = (artistNames: readonly string[]) =>
  artistNames.join(', ') || 'Finitude soundtrack';

/** Presents read-only playback context without owning audio, queue, or activity writes. */
export const NowPlayingAside = ({ store = playerStore }: NowPlayingAsideProps) => {
  const player = usePlayer(store);
  const current = player.currentItem;

  if (!current) {
    return (
      <section aria-label="Current soundtrack" className={`${styles.aside} ${styles.empty}`}>
        <p className={styles.eyebrow}>Now playing</p>
        <div className={styles.emptyCopy}>
          <h2>Nothing playing</h2>
          <p>Choose a soundtrack to see its details here.</p>
        </div>
      </section>
    );
  }

  const upNext = player.upNextItem;
  const repeatsCurrent = upNext?.id === current.id;

  return (
    <section aria-label="Current soundtrack" className={styles.aside}>
      <header className={styles.header}>
        <p className={styles.eyebrow}>Now playing</p>
        <h2 title={current.title}>{current.title}</h2>
      </header>

      <Artwork
        alt={`${current.title} cover`}
        className={styles.currentArtwork}
        fetchPriority="high"
        kind="audioTrack"
        loading="eager"
        sizes="min(22vw, 22rem)"
        src={current.artworkUrl}
      />

      <div className={styles.currentCopy}>
        <p className={styles.currentTitle} title={current.title}>{current.title}</p>
        <p className={styles.currentArtist}>{artistLabel(current.artistNames)}</p>
      </div>

      {upNext && (
        <section aria-labelledby="up-next-heading" className={styles.upNextCard}>
          <div className={styles.upNextHeader}>
            <h3 id="up-next-heading">{repeatsCurrent ? 'Repeats next' : 'Up next'}</h3>
            <span>{player.shuffleEnabled ? 'Shuffled order' : 'Playback order'}</span>
          </div>
          <div className={styles.upNextItem}>
            <Artwork
              alt=""
              className={styles.upNextArtwork}
              kind="audioTrack"
              sizes="3.25rem"
              src={upNext.artworkUrl}
            />
            <div>
              <p className={styles.upNextTitle} title={upNext.title}>{upNext.title}</p>
              <p className={styles.upNextArtist}>{artistLabel(upNext.artistNames)}</p>
            </div>
          </div>
        </section>
      )}
    </section>
  );
};

export default NowPlayingAside;
