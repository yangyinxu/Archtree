import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';

import { Icon } from '../../components/Icon';
import styles from './CatalogPages.module.css';

interface CompactCatalogHeaderProps {
  /** The page hero; the bar appears once it has scrolled up under the bar. */
  heroRef: RefObject<HTMLElement | null>;
  /** The hero's own Play, which takes focus if the bar hides while its Play is focused. */
  heroPlayRef: RefObject<HTMLButtonElement | null>;
  title: string;
  /** Accessible name of the bar's Play control, which must name the Album, not a track. */
  playLabel: string;
  playDisabled: boolean;
  onPlay: () => void;
  /** The pane tone, which keeps the bar's white title at AA contrast. */
  tone: string;
}

/**
 * Sticks to the top of the main pane and fades in the title and Play, on the page tone, once the
 * hero has scrolled under it. Rendered before the page so it overlays content without taking
 * layout space; while it shows, the main pane reserves its height for focus scrolling (see
 * CatalogPages.module.css). While hidden it is inert and removed from the accessibility tree, so it
 * never duplicates the hero's controls; its title stays hidden because the hero heading names the
 * page.
 */
export const CompactCatalogHeader = ({
  heroRef,
  heroPlayRef,
  title,
  playLabel,
  playDisabled,
  onPlay,
  tone
}: CompactCatalogHeaderProps) => {
  const barRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const hero = heroRef.current;
    if (!hero || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver((entries) => {
      // Several crossings can queue before one callback; the newest entry is the current state.
      const entry = entries[entries.length - 1];
      // Ignore a hero that is merely below the fold; only one that left through the top counts.
      const show = !entry.isIntersecting && entry.boundingClientRect.top < (entry.rootBounds?.top ?? 0);
      // An inert bar cannot keep focus, so hand it to the hero's Play before hiding.
      if (!show && barRef.current?.contains(document.activeElement)) {
        heroPlayRef.current?.focus({ preventScroll: true });
      }
      setVisible(show);
    }, {
      root: hero.closest('main'),
      rootMargin: `-${barRef.current?.offsetHeight ?? 0}px 0px 0px 0px`
    });
    observer.observe(hero);
    return () => observer.disconnect();
  }, [heroPlayRef, heroRef]);

  return (
    <div className={styles.compactHeader} data-visible={visible || undefined}>
      <div
        aria-hidden={!visible || undefined}
        className={styles.compactBar}
        inert={!visible || undefined}
        ref={barRef}
        style={{ '--tone-color': tone } as CSSProperties}
      >
        <button
          aria-label={playLabel}
          className={styles.playButton}
          disabled={playDisabled}
          onClick={onPlay}
          type="button"
        >
          <Icon name="play" />
        </button>
        <span aria-hidden="true">{title}</span>
      </div>
    </div>
  );
};
