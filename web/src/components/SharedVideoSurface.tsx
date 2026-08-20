import { useEffect, useRef } from 'react';

import type { PlayerStore } from '../player';
import styles from './SharedVideoSurface.module.css';

interface SharedVideoSurfaceProps {
  className?: string;
  nativeControls?: boolean;
  store: PlayerStore;
  title: string;
}

/** Hosts the one store-owned media element on whichever Video surface is visible. */
export const SharedVideoSurface = ({
  className = '',
  nativeControls = false,
  store,
  title
}: SharedVideoSurfaceProps) => {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!host.current) return undefined;
    return store.attachMediaElement(host.current);
  }, [store]);

  useEffect(() => {
    const media = host.current?.querySelector('video');
    if (!media) return undefined;

    media.controls = nativeControls;
    media.tabIndex = nativeControls ? 0 : -1;
    if (nativeControls) {
      media.removeAttribute('aria-hidden');
      media.setAttribute('aria-label', `${title} fullscreen video player`);
    } else {
      media.setAttribute('aria-hidden', 'true');
      media.removeAttribute('aria-label');
    }

    return () => {
      media.controls = false;
      media.tabIndex = -1;
      media.setAttribute('aria-hidden', 'true');
      media.removeAttribute('aria-label');
    };
  }, [nativeControls, title]);

  return (
    <div
      aria-label={nativeControls ? undefined : `${title} video`}
      className={`${styles.videoSurface} ${className}`}
      ref={host}
      role={nativeControls ? undefined : 'img'}
    />
  );
};
