import { useEffect, useRef, useState } from 'react';

import { playerStore, usePlayer, type PlayerStore } from '../player';
import { Icon } from './Icon';
import { SharedVideoSurface } from './SharedVideoSurface';
import styles from './VideoTheater.module.css';

interface VideoTheaterProps {
  store?: PlayerStore;
}

/** Presents the one store-owned Video element without creating another player or route. */
export const VideoTheater = ({ store = playerStore }: VideoTheaterProps) => {
  const player = usePlayer(store);
  const current = player.currentItem;
  const theater = useRef<HTMLElement>(null);
  const [nativeControls, setNativeControls] = useState(false);

  useEffect(() => {
    const syncFullscreenState = () => {
      const fullscreenElement = document.fullscreenElement;
      setNativeControls(Boolean(
        fullscreenElement && theater.current?.contains(fullscreenElement)
      ));
    };
    document.addEventListener('fullscreenchange', syncFullscreenState);
    return () => {
      document.removeEventListener('fullscreenchange', syncFullscreenState);
    };
  }, []);

  if (!current || current.mediaType !== 'video') return null;

  const enterFullscreen = async () => {
    const root = theater.current;
    const media = root?.querySelector('video');
    if (!root || !media) return;

    setNativeControls(true);
    try {
      if (typeof media.requestFullscreen === 'function') {
        await media.requestFullscreen();
      } else if (typeof root.requestFullscreen === 'function') {
        await root.requestFullscreen();
      } else {
        setNativeControls(false);
      }
    } catch {
      setNativeControls(false);
      // Fullscreen is optional; playback and the in-page theater remain available.
    }
  };

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
            <strong>Video could not play</strong>
            <span>{player.error.message}</span>
          </div>
        )}
      </div>

      <footer className={styles.footer}>
        <div className={styles.identity}>
          <span className={styles.badge}>Video</span>
          <div>
            <h1 id="video-theater-title" title={current.title}>{current.title}</h1>
            <p>{current.displayByline || current.artistNames.join(', ') || 'Finitude MediaTrack'}</p>
          </div>
        </div>
        <button
          aria-label="Enter video fullscreen"
          className={styles.fullscreen}
          onClick={() => { void enterFullscreen(); }}
          title="Fullscreen"
          type="button"
        >
          <Icon name="expand" />
        </button>
      </footer>
    </section>
  );
};

export default VideoTheater;
