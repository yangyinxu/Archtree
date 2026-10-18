import { useEffect, useMemo, useRef, type PointerEvent } from 'react';

import {
  loadArtworkTone,
  neutralArtworkTone,
  peekArtworkTone,
  setMainPaneTone
} from '../../artwork/useArtworkTone';

/** Media cards expose their artwork source for this lookup. */
const cardSelector = '[data-artwork-src]';
/**
 * How long the pointer or keyboard focus must rest before an unsampled card is sampled, or before
 * the tone returns to neutral. A sweep across a shelf therefore samples only the card it stops on,
 * and crossing the gap between cards never flashes the neutral tone.
 */
const restDelayMs = 150;

const cardArtwork = (target: EventTarget | null) => (
  target instanceof Element ? target.closest<HTMLElement>(cardSelector)?.dataset.artworkSrc ?? null : null
);

/** Only keyboard-style focus counts; a tap or click also focuses a card button but must not tint. */
const visibleFocusArtwork = () => {
  const focused = document.activeElement;
  return focused?.matches(':focus-visible') ? cardArtwork(focused) : null;
};

/**
 * Lets the hovered or keyboard-focused media card tint the main pane, Spotify-style, and returns
 * to the neutral tone once neither rests on a card. The hovered card wins over the focused one. It
 * writes the pane tone directly, so moving the pointer never re-renders Home. Touch pointers and
 * focus that is not :focus-visible (a tap or click) are ignored.
 */
export const useCardHoverTone = () => {
  const hovered = useRef<string | null>(null);
  const shown = useRef<string | null>(null);
  const restTimer = useRef(0);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    hovered.current = null;
    shown.current = null;
    setMainPaneTone(neutralArtworkTone.pane);
    return () => {
      mounted.current = false;
      window.clearTimeout(restTimer.current);
      setMainPaneTone(null);
    };
  }, []);

  return useMemo(() => {
    const target = () => hovered.current ?? visibleFocusArtwork();
    const show = (source: string | null) => {
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
    const update = () => {
      window.clearTimeout(restTimer.current);
      const source = target();
      if (source === shown.current) return;
      // A tone that is already known applies at once; sampling and the neutral fallback wait for a rest.
      if (source && peekArtworkTone(source)) show(source);
      else restTimer.current = window.setTimeout(() => show(target()), restDelayMs);
    };
    return {
      onBlur: update,
      onFocus: update,
      onPointerLeave: (event: PointerEvent) => {
        if (event.pointerType === 'touch') return;
        hovered.current = null;
        update();
      },
      onPointerOver: (event: PointerEvent) => {
        if (event.pointerType === 'touch') return;
        hovered.current = cardArtwork(event.target);
        update();
      }
    };
  }, []);
};
