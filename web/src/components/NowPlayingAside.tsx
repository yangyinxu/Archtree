import { Artwork } from './Artwork';
import {
  playerStore,
  usePlayer,
  type PlayerStore
} from '../player';
import styles from './NowPlayingAside.module.css';
import { useLocalization } from '../localization/LocalizationProvider';

interface NowPlayingAsideProps {
  /** Tests and alternate shells may inject the same store boundary used by PlayerBar. */
  store?: PlayerStore;
}

/** Presents read-only playback context without owning media, queue, or activity writes. */
export const NowPlayingAside = ({ store = playerStore }: NowPlayingAsideProps) => {
  const player = usePlayer(store);
  const { t } = useLocalization();
  const current = player.currentItem;
  const artistLabel = (item: { displayByline?: string; artistNames: readonly string[] }) =>
    item.displayByline || item.artistNames.join(', ') || t('now_playing.fallback_byline');

  if (!current) {
    return (
      <section aria-label={t('now_playing.current_label')} className={`${styles.aside} ${styles.empty}`}>
        <p className={styles.eyebrow}>{t('now_playing.eyebrow')}</p>
        <div className={styles.emptyCopy}>
          <h2>{t('now_playing.empty.title')}</h2>
          <p>{t('now_playing.empty.copy')}</p>
        </div>
      </section>
    );
  }

  const upNext = player.upNextItem;
  const repeatsCurrent = upNext?.id === current.id;

  if (current.mediaType === 'video') {
    return (
      <section aria-label={t('now_playing.video_queue_label')} className={`${styles.aside} ${styles.queueAside}`}>
        <header className={styles.header}>
          <p className={styles.eyebrow}>{t('now_playing.eyebrow')}</p>
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
            <h3 id="video-queue-heading">{t('now_playing.up_next')}</h3>
            <span>{player.shuffleEnabled
              ? t('now_playing.order.shuffled')
              : t('now_playing.order.playback')}</span>
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
                  <span className={styles.queueKind}>{item.mediaType === 'video'
                    ? t('common.label.video')
                    : t('common.label.audio')}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className={styles.queueEmpty}>{t('now_playing.queue_end')}</p>
          )}
        </section>
      </section>
    );
  }

  return (
    <section aria-label={t('now_playing.current_label')} className={styles.aside}>
      <header className={styles.header}>
        <p className={styles.eyebrow}>{t('now_playing.eyebrow')}</p>
        <h2 title={current.title}>{current.title}</h2>
      </header>

      <Artwork
        alt={t('content.album.cover_alt', { title: current.title })}
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
            <h3 id="up-next-heading">{repeatsCurrent
              ? t('now_playing.repeats_next')
              : t('now_playing.up_next')}</h3>
            <span>{player.shuffleEnabled
              ? t('now_playing.order.shuffled')
              : t('now_playing.order.playback')}</span>
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
