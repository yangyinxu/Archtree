import { useEffect, useMemo, useRef, type FocusEvent, type PointerEvent } from 'react';

import { loadArtworkTone, neutralArtworkTone, setMainPaneTone } from '../../artwork/useArtworkTone';

/** Media cards expose their artwork source for this lookup. */
const cardSelector = '[data-artwork-src]';
/** Lets the pointer cross the gap between neighbouring cards without a neutral flash. */
const revertDelayMs = 150;

const cardArtwork = (target: EventTarget | null) => (
  target instanceof Element ? target.closest<HTMLElement>(cardSelector)?.dataset.artworkSrc ?? null : null
);

/**
 * Lets the hovered or keyboard-focused media card tint the main pane, Spotify-style, and returns
 * to the neutral tone once neither rests on a card. It writes the pane tone directly, so moving
 * the pointer never re-renders Home. Touch pointers are ignored because a tap navigates instead.
 */
export const useCardHoverTone = () => {
  const shown = useRef<string | null>(null);
  const revertTimer = useRef(0);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    shown.current = null;
    setMainPaneTone(neutralArtworkTone.pane);
    return () => {
      mounted.current = false;
      window.clearTimeout(revertTimer.current);
      setMainPaneTone(null);
    };
  }, []);

  return useMemo(() => {
    const show = (source: string | null) => {
      window.clearTimeout(revertTimer.current);
      if (source === shown.current) return;
      shown.current = source;
      if (!source) {
        setMainPaneTone(neutralArtworkTone.pane);
        return;
      }
      void loadArtworkTone(source).then((tone) => {
        if (mounted.current && shown.current === source) setMainPaneTone(tone.pane);
      });
    };
    const follow = (target: EventTarget | null) => {
      const source = cardArtwork(target);
      if (source) {
        show(source);
        return;
      }
      window.clearTimeout(revertTimer.current);
      // A keyboard-focused card keeps the tone after the pointer leaves the cards.
      revertTimer.current = window.setTimeout(() => show(cardArtwork(document.activeElement)), revertDelayMs);
    };
    return {
      onBlur: (event: FocusEvent) => follow(event.relatedTarget),
      onFocus: (event: FocusEvent) => follow(event.target),
      onPointerLeave: (event: PointerEvent) => { if (event.pointerType !== 'touch') follow(null); },
      onPointerOver: (event: PointerEvent) => { if (event.pointerType !== 'touch') follow(event.target); }
    };
  }, []);
};
