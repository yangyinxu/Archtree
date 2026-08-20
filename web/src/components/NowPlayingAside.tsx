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

const artistLabel = (item: { displayByline?: string; artistNames: readonly string[] }) =>
  item.displayByline || item.artistNames.join(', ') || 'Finitude MediaTrack';

/** Presents read-only playback context without owning media, queue, or activity writes. */
export const NowPlayingAside = ({ store = playerStore }: NowPlayingAsideProps) => {
  const player = usePlayer(store);
  const current = player.currentItem;

  if (!current) {
    return (
      <section aria-label="Current MediaTrack" className={`${styles.aside} ${styles.empty}`}>
        <p className={styles.eyebrow}>Now playing</p>
        <div className={styles.emptyCopy}>
          <h2>Nothing playing</h2>
          <p>Choose a MediaTrack to see its details here.</p>
        </div>
      </section>
    );
  }

  const upNext = player.upNextItem;
  const repeatsCurrent = upNext?.id === current.id;

  if (current.mediaType === 'video') {
    return (
      <section aria-label="Video playback queue" className={`${styles.aside} ${styles.queueAside}`}>
        <header className={styles.header}>
          <p className={styles.eyebrow}>Now playing</p>
          <h2 title={current.title}>{current.title}</h2>
        </header>

        <div className={styles.queueCurrent} aria-current="true">
          <Artwork
            alt=""
            className={styles.queueArtwork}
            kind="audioTrack"
            sizes="3.5rem"
            src={current.artworkUrl}
          />
          <div>
            <p className={styles.upNextTitle} title={current.title}>{current.title}</p>
            <p className={styles.upNextArtist}>{artistLabel(current)}</p>
          </div>
        </div>

        <section aria-labelledby="video-queue-heading" className={styles.queueSection}>
          <div className={styles.upNextHeader}>
            <h3 id="video-queue-heading">Up next</h3>
            <span>{player.shuffleEnabled ? 'Shuffled order' : 'Playback order'}</span>
          </div>
          {player.upNextItems.length > 0 ? (
            <ol className={styles.queueList}>
              {player.upNextItems.map((item, index) => (
                <li className={styles.queueItem} key={`${item.id}-${index}`}>
                  <span className={styles.queueNumber}>{index + 1}</span>
                  <Artwork
                    alt=""
                    className={styles.queueArtwork}
                    kind="audioTrack"
                    sizes="3.5rem"
                    src={item.artworkUrl}
                  />
                  <div>
                    <p className={styles.upNextTitle} title={item.title}>{item.title}</p>
                    <p className={styles.upNextArtist}>{artistLabel(item)}</p>
                  </div>
                  <span className={styles.queueKind}>{item.mediaType === 'video' ? 'Video' : 'Audio'}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className={styles.queueEmpty}>This is the end of the queue.</p>
          )}
        </section>
      </section>
    );
  }

  return (
    <section aria-label="Current MediaTrack" className={styles.aside}>
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
        <p className={styles.currentArtist}>{artistLabel(current)}</p>
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
              <p className={styles.upNextArtist}>{artistLabel(upNext)}</p>
            </div>
          </div>
        </section>
      )}
    </section>
  );
};

export default NowPlayingAside;
