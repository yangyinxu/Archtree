import { useEffect, useRef, useState } from 'react';

import styles from './CardVideoPreview.module.css';

// Previews loop a short window from a little way into the video, where openings are rarely blank.
const previewStartFraction = 0.2;
const previewMaximumStartSeconds = 30;
const previewWindowSeconds = 8;

export interface CardVideoPreviewProps {
  source: string;
  onFailed: () => void;
}

/**
 * A decorative, muted, looping preview drawn over a Video card's artwork. It owns its own media
 * element, separate from the shared player, and releases its request when it unmounts.
 */
export default function CardVideoPreview({ source, onFailed }: CardVideoPreviewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    let start = 0;
    video.muted = true;
    video.defaultMuted = true;
    video.disablePictureInPicture = true;
    if ('disableRemotePlayback' in video) video.disableRemotePlayback = true;

    const begin = () => {
      start = Number.isFinite(video.duration)
        ? Math.min(video.duration * previewStartFraction, previewMaximumStartSeconds)
        : 0;
      video.currentTime = start;
      video.play()?.catch?.(() => onFailed());
    };
    const loopWindow = () => {
      if (video.currentTime > start + previewWindowSeconds) video.currentTime = start;
    };
    const reveal = () => setReady(true);
    const fail = () => onFailed();

    video.addEventListener('loadedmetadata', begin);
    video.addEventListener('timeupdate', loopWindow);
    video.addEventListener('playing', reveal);
    video.addEventListener('error', fail);
    video.src = source;

    return () => {
      video.removeEventListener('loadedmetadata', begin);
      video.removeEventListener('timeupdate', loopWindow);
      video.removeEventListener('playing', reveal);
      video.removeEventListener('error', fail);
      // Clearing the source aborts the in-flight range request instead of finishing the download.
      video.pause();
      video.removeAttribute('src');
      video.load();
    };
  }, [onFailed, source]);

  return (
    <video
      aria-hidden="true"
      className={styles.preview}
      data-ready={ready || undefined}
      data-video-preview=""
      loop
      muted
      playsInline
      preload="metadata"
      ref={videoRef}
      tabIndex={-1}
    />
  );
}
