import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent
} from 'react';

import styles from './SeekSlider.module.css';

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(Math.max(value, minimum), maximum);

export const formatPlaybackTime = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
};

type SeekStyle = CSSProperties & {
  '--seek-progress': string;
  '--seek-preview': string;
};

interface SeekSliderProps {
  currentTime: number;
  duration: number;
  itemKey?: string;
  onSeek(time: number): void;
}

/** Previews pointer seeking locally and commits only the listener's final position. */
export const SeekSlider = ({ currentTime, duration, itemKey, onSeek }: SeekSliderProps) => {
  const [previewTime, setPreviewTime] = useState<number | null>(null);
  const [scrubTime, setScrubTime] = useState<number | null>(null);
  const isScrubbing = useRef(false);
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const disabled = safeDuration === 0;
  const safeCurrentTime = disabled
    ? 0
    : clamp(Number.isFinite(currentTime) ? currentTime : 0, 0, safeDuration);
  const visibleTime = scrubTime ?? safeCurrentTime;
  const progressPercent = disabled ? 0 : (visibleTime / safeDuration) * 100;
  const previewPercent = previewTime === null || disabled
    ? progressPercent
    : (previewTime / safeDuration) * 100;
  const seekStyle: SeekStyle = {
    '--seek-progress': `${progressPercent}%`,
    '--seek-preview': `${previewPercent}%`
  };

  useEffect(() => {
    isScrubbing.current = false;
    setPreviewTime(null);
    setScrubTime(null);
  }, [itemKey]);

  const timeAtPointer = (event: ReactPointerEvent<HTMLInputElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (disabled || bounds.width <= 0) return safeCurrentTime;
    const ratio = clamp((event.clientX - bounds.left) / bounds.width, 0, 1);
    return ratio * safeDuration;
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLInputElement>) => {
    if (disabled || event.button !== 0) return;
    isScrubbing.current = true;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is an enhancement; the release handler still commits locally.
    }
    const nextTime = timeAtPointer(event);
    setScrubTime(nextTime);
    setPreviewTime(nextTime);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLInputElement>) => {
    if (disabled) return;
    const nextTime = timeAtPointer(event);
    setPreviewTime(nextTime);
    if (isScrubbing.current) setScrubTime(nextTime);
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLInputElement>) => {
    if (!isScrubbing.current || disabled) return;
    const nextTime = timeAtPointer(event);
    isScrubbing.current = false;
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // Browsers without pointer capture still complete the local seek.
    }
    setScrubTime(null);
    setPreviewTime(nextTime);
    onSeek(nextTime);
  };

  const cancelPointer = () => {
    isScrubbing.current = false;
    setScrubTime(null);
    setPreviewTime(null);
  };

  return (
    <span className={styles.seek} style={seekStyle}>
      <input
        aria-label="Playback position"
        aria-valuetext={formatPlaybackTime(visibleTime)}
        className={styles.input}
        data-scrubbing={isScrubbing.current || undefined}
        disabled={disabled}
        max={safeDuration}
        min="0"
        onBlur={() => setPreviewTime(null)}
        onChange={(event) => {
          const nextTime = clamp(Number(event.currentTarget.value), 0, safeDuration);
          if (isScrubbing.current) setScrubTime(nextTime);
          else {
            setPreviewTime(nextTime);
            onSeek(nextTime);
          }
        }}
        onPointerCancel={cancelPointer}
        onPointerDown={handlePointerDown}
        onPointerLeave={() => {
          if (!isScrubbing.current) setPreviewTime(null);
        }}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        step="0.1"
        type="range"
        value={visibleTime}
      />
      {previewTime !== null && !disabled && (
        <output aria-hidden="true" className={styles.preview}>
          {formatPlaybackTime(previewTime)}
        </output>
      )}
    </span>
  );
};
