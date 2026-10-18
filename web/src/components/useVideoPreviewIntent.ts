import { useCallback, useEffect, useRef, useState } from 'react';

const intentDelayMs = 500;
const slowConnectionTypes = new Set(['slow-2g', '2g', '3g']);
// A source that failed once is not retried in this page session, so a broken stream costs one request.
const failedSources = new Set<string>();
// Only one card previews at a time; a newly started preview stops the previous one.
let stopActivePreview: (() => void) | null = null;

type NetworkInformationLike = { saveData?: boolean; effectiveType?: string };

/** Whether the device, page and listener settings allow a decorative hover preview right now. */
export const videoPreviewAllowed = () => {
  if (typeof window.matchMedia !== 'function' || document.visibilityState === 'hidden') return false;
  if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return false;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  if (window.matchMedia('(forced-colors: active)').matches) return false;
  const connection = (navigator as Navigator & { connection?: NetworkInformationLike }).connection;
  return !connection?.saveData && !slowConnectionTypes.has(connection?.effectiveType ?? '');
};

/**
 * Starts a card's muted preview only after a mouse rests on it, and stops it on leave, on any press
 * inside the card, when the page hides, or when another card starts one. It listens with native
 * boundary events on the card element, because React's tree-based enter/leave events treat a
 * portaled dialog opened from the card as still inside it. The preview never touches the player.
 */
export const useVideoPreviewIntent = (source: string | null) => {
  const [active, setActive] = useState(false);
  const timer = useRef<number | null>(null);
  const currentSource = useRef(source);
  currentSource.current = source;

  const stop = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    if (stopActivePreview === stop) stopActivePreview = null;
    setActive(false);
  }, []);

  const startAfterIntent = useCallback(() => {
    const initial = currentSource.current;
    if (!initial || failedSources.has(initial) || !videoPreviewAllowed()) return;
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      const latest = currentSource.current;
      // Conditions can change during the wait, such as the tab hiding or the card becoming current playback.
      if (!latest || failedSources.has(latest) || !videoPreviewAllowed()) return;
      if (stopActivePreview && stopActivePreview !== stop) stopActivePreview();
      stopActivePreview = stop;
      setActive(true);
    }, intentDelayMs);
  }, [stop]);

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

  /** Callback ref for the card element; React 19 runs the returned cleanup on detach. */
  const cardRef = useCallback((element: HTMLElement | null) => {
    if (!element) return undefined;
    const enter = (event: PointerEvent) => {
      if (event.pointerType === 'mouse') startAfterIntent();
    };
    element.addEventListener('pointerenter', enter);
    element.addEventListener('pointerleave', stop);
    element.addEventListener('pointerdown', stop);
    return () => {
      element.removeEventListener('pointerenter', enter);
      element.removeEventListener('pointerleave', stop);
      element.removeEventListener('pointerdown', stop);
    };
  }, [startAfterIntent, stop]);

  const onFailed = useCallback(() => {
    if (source) failedSources.add(source);
    stop();
  }, [source, stop]);

  return { active: active && Boolean(source), cardRef, onFailed };
};
