import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';

import { Icon } from '../../components/Icon';
import styles from './CatalogPages.module.css';

interface CompactCatalogHeaderProps {
  /** The page hero; the bar appears once it has scrolled up under the bar. */
  heroRef: RefObject<HTMLElement | null>;
  title: string;
  /** Accessible name of the bar's Play control, which must name the title. */
  playLabel: string;
  playDisabled: boolean;
  onPlay: () => void;
  /** The pane tone, which keeps the bar's white title at AA contrast. */
  tone: string;
}

/**
 * Sticks to the top of the main pane and fades in the title and Play, on the page tone, once the
 * hero has scrolled under it. Rendered before the page so it overlays content without taking
 * layout space. While hidden it is inert and removed from the accessibility tree, so it never
 * duplicates the hero's controls; its title stays hidden because the hero heading names the page.
 */
export const CompactCatalogHeader = ({
  heroRef,
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
    const observer = new IntersectionObserver(([entry]) => {
      // Ignore a hero that is merely below the fold; only one that left through the top counts.
      setVisible(!entry.isIntersecting && entry.boundingClientRect.top < (entry.rootBounds?.top ?? 0));
    }, {
      root: hero.closest('main'),
      rootMargin: `-${barRef.current?.offsetHeight ?? 0}px 0px 0px 0px`
    });
    observer.observe(hero);
    return () => observer.disconnect();
  }, [heroRef]);

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
