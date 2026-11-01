import { localizedPlayerError, playerStore, usePlayer, type PlayerStore } from '../player';
import { Icon } from './Icon';
import { SharedVideoSurface, useVideoFullscreen } from './SharedVideoSurface';
import styles from './VideoTheater.module.css';
import { useLocalization } from '../localization/LocalizationProvider';

interface VideoTheaterProps {
  store?: PlayerStore;
}

/** Presents the one store-owned Video element without creating another player or route. */
export const VideoTheater = ({ store = playerStore }: VideoTheaterProps) => {
  const player = usePlayer(store);
  const current = player.currentItem;
  const { enterFullscreen, nativeControls, root: theater } = useVideoFullscreen<HTMLElement>();
  const { t } = useLocalization();

  if (!current || current.mediaType !== 'video') return null;

  return (
    <section
      aria-labelledby="video-theater-title"
      className={styles.theater}
      ref={theater}
    >
      <div className={styles.stage}>
        <SharedVideoSurface
          className={styles.video}
          nativeControls={nativeControls}
          store={store}
          title={current.title}
        />
        {player.error && (
          <div className={styles.error} role="alert">
            <strong>{t('video.error.title')}</strong>
            <span>{localizedPlayerError(player.error.code, t)}</span>
          </div>
        )}
      </div>

      <footer className={styles.footer}>
        <div className={styles.identity}>
          <span className={styles.badge}>{t('common.label.video')}</span>
          <div>
            <h1 id="video-theater-title" title={current.title}>{current.title}</h1>
            <p>{current.displayByline || current.artistNames.join(', ') || t('now_playing.fallback_byline')}</p>
          </div>
        </div>
        <button
          aria-label={t('video.fullscreen.action')}
          className={styles.fullscreen}
          onClick={() => { void enterFullscreen(); }}
          title={t('video.fullscreen.title')}
          type="button"
        >
          <Icon name="expand" />
        </button>
      </footer>
    </section>
  );
};

export default VideoTheater;
