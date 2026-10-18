import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';

const intentDelayMs = 500;
const slowConnectionTypes = new Set(['slow-2g', '2g', '3g']);
// A source that failed once is not retried in this page session, so a broken stream costs one request.
const failedSources = new Set<string>();
// Only one card previews at a time; a newly started preview stops the previous one.
let stopActivePreview: (() => void) | null = null;

type NetworkInformationLike = { saveData?: boolean; effectiveType?: string };

/** Whether the device and listener settings allow a decorative hover preview right now. */
export const videoPreviewAllowed = () => {
  if (typeof window.matchMedia !== 'function') return false;
  if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return false;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  const connection = (navigator as Navigator & { connection?: NetworkInformationLike }).connection;
  return !connection?.saveData && !slowConnectionTypes.has(connection?.effectiveType ?? '');
};

/**
 * Starts a card's muted preview only after a mouse rests on it, and stops it on leave, when the
 * page hides, or when another card starts one. The preview never touches the shared player.
 */
export const useVideoPreviewIntent = (source: string | null) => {
  const [active, setActive] = useState(false);
  const timer = useRef<number | null>(null);

  const stop = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    if (stopActivePreview === stop) stopActivePreview = null;
    setActive(false);
  }, []);

  useEffect(() => {
    if (!source) stop();
  }, [source, stop]);

  useEffect(() => stop, [stop]);

  useEffect(() => {
    if (!active) return undefined;
    const stopWhenHidden = () => {
      if (document.visibilityState === 'hidden') stop();
    };
    document.addEventListener('visibilitychange', stopWhenHidden);
    return () => document.removeEventListener('visibilitychange', stopWhenHidden);
  }, [active, stop]);

  const onPointerEnter = (event: PointerEvent) => {
    if (!source || event.pointerType !== 'mouse' || failedSources.has(source) || !videoPreviewAllowed()) return;
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      if (stopActivePreview && stopActivePreview !== stop) stopActivePreview();
      stopActivePreview = stop;
      setActive(true);
    }, intentDelayMs);
  };

  const onFailed = useCallback(() => {
    if (source) failedSources.add(source);
    stop();
  }, [source, stop]);

  return { active: active && Boolean(source), onPointerEnter, onPointerLeave: stop, onFailed };
};
