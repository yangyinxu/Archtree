import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Mounts a card's lazy preview only after a mouse rests on it for 500 ms, and stops it on leave or
 * on any press inside the card. Eligibility, failure memory, page visibility and the one-preview
 * limit live in the lazily loaded preview so this shared bundle stays small. Native boundary
 * events are used because React's tree-based ones treat a portaled dialog opened from the card as
 * still inside it.
 */
export const useVideoPreviewIntent = (source: string | null) => {
  const [active, setActive] = useState(false);
  const timer = useRef(0);
  const enabled = Boolean(source);

  const stop = useCallback(() => {
    clearTimeout(timer.current);
    setActive(false);
  }, []);

  // Any source change, such as the card becoming current playback, or unmounting ends the preview
  // and any pending intent.
  useEffect(() => stop, [source, stop]);

  /** Callback ref for the card element; React 19 runs the returned cleanup on detach. */
  const cardRef = useCallback((element: HTMLElement | null) => {
    if (!element || !enabled) return undefined;
    const enter = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse') return;
      clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setActive(true), 500);
    };
    element.addEventListener('pointerenter', enter);
    element.addEventListener('pointerleave', stop);
    element.addEventListener('pointerdown', stop);
    return () => {
      element.removeEventListener('pointerenter', enter);
      element.removeEventListener('pointerleave', stop);
      element.removeEventListener('pointerdown', stop);
    };
  }, [enabled, stop]);

  // Callers render the preview only while they still have a source, so a stale flag never shows.
  return { active, cardRef, stop };
};
