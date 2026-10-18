import { useLayoutEffect, useRef } from 'react';

/**
 * Hero title size steps, largest first (see `.albumTitle` in CatalogPages.module.css). Every step
 * but the last clamps to three lines; the last never clamps, so the full title always shows.
 */
const titleSizes = [undefined, 'medium', 'small', 'xsmall', 'xxsmall'] as const;

/** CJK, Hangul, and full-width characters take about two Latin character widths. */
const wideCharacter = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/;

/** Estimates the first step from the title's weighted length, before any layout is known. */
const estimatedStep = (title: string) => {
  let length = 0;
  for (const character of title) length += wideCharacter.test(character) ? 2 : 1;
  return length > 56 ? 3 : length > 32 ? 2 : length > 18 ? 1 : 0;
};

/**
 * Sizes a hero title to its column: it starts from the length estimate and steps down until the
 * title fits within three lines at the current width, and fits again whenever the main pane
 * resizes. The pane, not the heading, is observed, because fitting changes the heading's own size.
 * Pass null while no heading is rendered, so a later heading is fitted even if the title repeats.
 */
export const useFittedHeroTitle = (title: string | null) => {
  const ref = useRef<HTMLHeadingElement>(null);
  const initialSize = titleSizes[estimatedStep(title ?? '')];

  useLayoutEffect(() => {
    const heading = ref.current;
    if (!heading || title === null) return undefined;
    // Tight line-height lets glyphs overflow by a pixel or two; a clamped line hides far more.
    const clamped = () => heading.scrollHeight - heading.clientHeight
      > (Number.parseFloat(getComputedStyle(heading).fontSize) || 16) / 2;
    const fit = () => {
      for (let step = estimatedStep(title); ; step += 1) {
        const size = titleSizes[step];
        if (size) heading.dataset.titleSize = size;
        else delete heading.dataset.titleSize;
        if (step === titleSizes.length - 1 || !clamped()) return;
      }
    };
    fit();
    const pane = heading.closest('main');
    if (!pane || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(fit);
    observer.observe(pane);
    return () => observer.disconnect();
  }, [title]);

  return { ref, initialSize };
};
