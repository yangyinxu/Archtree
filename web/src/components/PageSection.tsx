import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
} from 'react';

import type { AlbumSummary, AudioTrackSummary, SectionPresentation } from '../api/contentSchemas';
import { ContentCard } from './ContentCard';
import { ContentListRow } from './ContentListRow';
import { Icon } from './Icon';
import styles from './PageSection.module.css';

const carouselEdgeTolerance = 1;
const carouselControlRevealMs = 1_400;

interface CarouselScrollState {
  canScrollBack: boolean;
  canScrollForward: boolean;
}

type CarouselScrollCommand = 'back' | 'end' | 'forward' | 'start';

const initialCarouselScrollState: CarouselScrollState = {
  canScrollBack: false,
  canScrollForward: false
};

/** Normalizes fractional and elastic scroll offsets before deriving edge state. */
const readCarouselScrollState = (carousel: HTMLUListElement): CarouselScrollState => {
  const maximumScroll = Math.max(0, carousel.scrollWidth - carousel.clientWidth);
  const currentScroll = Math.min(maximumScroll, Math.max(0, carousel.scrollLeft));
  return {
    canScrollBack: currentScroll > carouselEdgeTolerance,
    canScrollForward: maximumScroll - currentScroll > carouselEdgeTolerance
  };
};

/** Moves by roughly one viewport minus one card while retaining a stable card boundary. */
const carouselPageTarget = (
  carousel: HTMLUListElement,
  direction: 'back' | 'forward'
) => {
  const maximumScroll = Math.max(0, carousel.scrollWidth - carousel.clientWidth);
  const currentScroll = Math.min(maximumScroll, Math.max(0, carousel.scrollLeft));
  const [firstCard, secondCard] = Array.from(carousel.children) as HTMLElement[];
  const stride = Math.max(
    1,
    secondCard?.offsetLeft - firstCard?.offsetLeft
      || (firstCard?.offsetWidth ?? 0) + (Number.parseFloat(getComputedStyle(carousel).columnGap) || 0)
      || carousel.clientWidth
  );
  const visibleDistance = Math.max(stride, carousel.clientWidth - stride);
  const pageDistance = Math.max(stride, Math.floor(visibleDistance / stride) * stride);
  const rawTarget = Math.min(
    maximumScroll,
    Math.max(0, currentScroll + (direction === 'forward' ? pageDistance : -pageDistance))
  );
  if (rawTarget <= carouselEdgeTolerance) return 0;
  if (maximumScroll - rawTarget <= carouselEdgeTolerance) return maximumScroll;
  return Math.min(maximumScroll, Math.max(0, Math.round(rawTarget / stride) * stride));
};

export interface PageSectionProps {
  id: string;
  title: string;
  presentation: SectionPresentation;
  items: Array<AlbumSummary | AudioTrackSummary>;
  onPlay?: (audioTrack: AudioTrackSummary) => void;
  renderTrackTrailing?: (audioTrack: AudioTrackSummary) => ReactNode;
}

/** Preserves the creator-selected Carousel, Grid, or List presentation at every width. */
export const PageSection = ({
  id,
  title,
  presentation,
  items,
  onPlay,
  renderTrackTrailing
}: PageSectionProps) => {
  const headingId = `listener-section-${id}`;
  const carouselHelpId = `${headingId}-help`;
  const carouselId = `${headingId}-carousel`;
  const carouselRef = useRef<HTMLUListElement>(null);
  const previousControlRef = useRef<HTMLButtonElement>(null);
  const nextControlRef = useRef<HTMLButtonElement>(null);
  const pendingControlFocusRef = useRef<'back' | 'forward' | null>(null);
  const controlRevealTimerRef = useRef<number | null>(null);
  const [carouselScrollState, setCarouselScrollState] = useState(initialCarouselScrollState);
  const cardArtworkSizes = presentation === 'carousel'
    ? '(max-width: 480px) calc(min(72vw, 17.5rem) - 1.3rem - 2px), calc(clamp(10.5rem, 16vw, 13rem) - 1.3rem - 2px)'
    : '(max-width: 340px) calc(100vw - 3.3rem - 2px), (max-width: 480px) calc((100vw - 2.75rem) / 2 - 1.3rem - 2px), (max-width: 1023px) calc(10.5rem - 1.3rem - 2px), calc(14rem - 1.3rem - 2px)';

  const revealControlsAfterScroll = useCallback(() => {
    const frame = carouselRef.current?.parentElement;
    if (!frame) return;
    frame.dataset.recentlyScrolled = 'true';
    if (controlRevealTimerRef.current !== null) {
      window.clearTimeout(controlRevealTimerRef.current);
    }
    controlRevealTimerRef.current = window.setTimeout(() => {
      frame.removeAttribute('data-recently-scrolled');
      controlRevealTimerRef.current = null;
    }, carouselControlRevealMs);
  }, []);

  const updateCarouselScrollState = useCallback(() => {
    const carousel = carouselRef.current;
    const nextState = carousel
      ? readCarouselScrollState(carousel)
      : initialCarouselScrollState;
    const focusedElement = document.activeElement;
    if (focusedElement === previousControlRef.current && !nextState.canScrollBack) {
      pendingControlFocusRef.current = 'forward';
    } else if (focusedElement === nextControlRef.current && !nextState.canScrollForward) {
      pendingControlFocusRef.current = 'back';
    }
    setCarouselScrollState((currentState) => currentState.canScrollBack === nextState.canScrollBack
      && currentState.canScrollForward === nextState.canScrollForward
      ? currentState
      : nextState);
  }, []);

  useEffect(() => {
    const carousel = presentation === 'carousel' ? carouselRef.current : null;
    if (!carousel) {
      setCarouselScrollState(initialCarouselScrollState);
      return undefined;
    }

    let disposed = false;
    const handleScroll = () => {
      updateCarouselScrollState();
      revealControlsAfterScroll();
    };
    const handleLayoutChange = () => updateCarouselScrollState();
    const resizeObserver = typeof ResizeObserver === 'function'
      ? new ResizeObserver(handleLayoutChange)
      : null;

    updateCarouselScrollState();
    carousel.addEventListener('scroll', handleScroll, { passive: true });
    resizeObserver?.observe(carousel);
    window.addEventListener('resize', handleLayoutChange);

    const fontSet = document.fonts;
    const handleFontLoading = () => handleLayoutChange();
    fontSet?.addEventListener('loadingdone', handleFontLoading);
    void fontSet?.ready.then(() => {
      if (!disposed) handleLayoutChange();
    });

    return () => {
      disposed = true;
      carousel.removeEventListener('scroll', handleScroll);
      resizeObserver?.disconnect();
      window.removeEventListener('resize', handleLayoutChange);
      fontSet?.removeEventListener('loadingdone', handleFontLoading);
    };
  }, [items.length, presentation, revealControlsAfterScroll, updateCarouselScrollState]);

  useLayoutEffect(() => {
    const pendingDirection = pendingControlFocusRef.current;
    if (!pendingDirection) return;
    const replacementControl = pendingDirection === 'back'
      ? previousControlRef.current
      : nextControlRef.current;
    (replacementControl ?? carouselRef.current)?.focus({ preventScroll: true });
    pendingControlFocusRef.current = null;
  }, [carouselScrollState.canScrollBack, carouselScrollState.canScrollForward]);

  useEffect(() => () => {
    if (controlRevealTimerRef.current !== null) {
      window.clearTimeout(controlRevealTimerRef.current);
    }
  }, []);

  const scrollCarousel = useCallback((command: CarouselScrollCommand) => {
    const carousel = carouselRef.current;
    if (!carousel) return;
    const maximumScroll = Math.max(0, carousel.scrollWidth - carousel.clientWidth);
    const target = command === 'start'
      ? 0
      : command === 'end'
        ? maximumScroll
        : carouselPageTarget(carousel, command);

    if (Math.abs(target - carousel.scrollLeft) <= carouselEdgeTolerance) {
      updateCarouselScrollState();
      return;
    }

    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const behavior: ScrollBehavior = reducedMotion ? 'auto' : 'smooth';
    if (typeof carousel.scrollTo === 'function') {
      carousel.scrollTo({ behavior, left: target });
    } else {
      carousel.scrollLeft = target;
      updateCarouselScrollState();
    }
    revealControlsAfterScroll();
  }, [revealControlsAfterScroll, updateCarouselScrollState]);

  const handleCarouselKeyDown = useCallback((event: ReactKeyboardEvent<HTMLUListElement>) => {
    if (event.target !== event.currentTarget) return;
    const command = event.key === 'PageUp'
      ? 'back'
      : event.key === 'PageDown'
        ? 'forward'
        : event.key === 'Home'
          ? 'start'
          : event.key === 'End'
            ? 'end'
            : null;
    if (!command) return;
    event.preventDefault();
    scrollCarousel(command);
  }, [scrollCarousel]);

  const collection = (
    <ul
      aria-describedby={presentation === 'carousel' ? carouselHelpId : undefined}
      aria-label={presentation === 'carousel' ? `${title} carousel` : undefined}
      className={styles[presentation]}
      data-presentation={presentation}
      id={presentation === 'carousel' ? carouselId : undefined}
      onKeyDown={presentation === 'carousel' ? handleCarouselKeyDown : undefined}
      ref={presentation === 'carousel' ? carouselRef : undefined}
      tabIndex={presentation === 'carousel' ? 0 : undefined}
    >
      {presentation === 'list'
        ? items.map((item) => (
            <ContentListRow
              item={item}
              key={`${item.contentType}:${item.id}`}
              onPlay={onPlay}
              trailing={item.contentType === 'audioTrack' ? renderTrackTrailing?.(item) : undefined}
            />
          ))
        : items.map((item) => (
          <li className={styles.cardItem} key={`${item.contentType}:${item.id}`}>
            <ContentCard artworkSizes={cardArtworkSizes} item={item} onPlay={onPlay} />
          </li>
        ))}
    </ul>
  );

  return (
    <section className={styles.section} aria-labelledby={headingId}>
      <h2 className={styles.title} id={headingId}>{title}</h2>
      {items.length === 0 ? (
        <p className={styles.empty}>No music is available in this section yet.</p>
      ) : (
        <>
          {presentation === 'carousel' && (
            <p className={styles.visuallyHidden} id={carouselHelpId}>
              Use the previous and next controls, Page Up and Page Down, or Home and End to explore this carousel.
            </p>
          )}
          {presentation === 'carousel' ? (
            <div
              className={styles.carouselFrame}
            >
              {collection}
              {(carouselScrollState.canScrollBack || carouselScrollState.canScrollForward) && (
                <div
                  aria-label={`${title} carousel controls`}
                  className={styles.carouselControls}
                  role="group"
                >
                  {carouselScrollState.canScrollBack && (
                    <button
                      aria-controls={carouselId}
                      aria-label={`Show previous items in ${title}`}
                      className={`${styles.carouselControl} ${styles.carouselControlPrevious}`}
                      onClick={() => scrollCarousel('back')}
                      ref={previousControlRef}
                      title={`Show previous items in ${title}`}
                      type="button"
                    >
                      <Icon name="arrow-left" />
                    </button>
                  )}
                  {carouselScrollState.canScrollForward && (
                    <button
                      aria-controls={carouselId}
                      aria-label={`Show next items in ${title}`}
                      className={`${styles.carouselControl} ${styles.carouselControlNext}`}
                      onClick={() => scrollCarousel('forward')}
                      ref={nextControlRef}
                      title={`Show next items in ${title}`}
                      type="button"
                    >
                      <Icon name="arrow-right" />
                    </button>
                  )}
                </div>
              )}
            </div>
          ) : collection}
        </>
      )}
    </section>
  );
};
