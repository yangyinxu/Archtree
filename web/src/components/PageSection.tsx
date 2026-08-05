import type { AlbumSummary, AudioTrackSummary, SectionPresentation } from '../api/contentSchemas';
import { ContentCard } from './ContentCard';
import { ContentListRow } from './ContentListRow';
import styles from './PageSection.module.css';

export interface PageSectionProps {
  id: string;
  title: string;
  presentation: SectionPresentation;
  items: Array<AlbumSummary | AudioTrackSummary>;
  onPlay?: (audioTrack: AudioTrackSummary) => void;
}

/** Preserves the creator-selected Carousel, Grid, or List presentation at every width. */
export const PageSection = ({ id, title, presentation, items, onPlay }: PageSectionProps) => {
  const headingId = `listener-section-${id}`;
  const carouselHelpId = `${headingId}-help`;
  const cardArtworkSizes = presentation === 'carousel'
    ? '(max-width: 480px) calc(min(72vw, 17.5rem) - 1.3rem - 2px), calc(clamp(10.5rem, 16vw, 13rem) - 1.3rem - 2px)'
    : '(max-width: 340px) calc(100vw - 3.3rem - 2px), (max-width: 480px) calc((100vw - 2.75rem) / 2 - 1.3rem - 2px), (max-width: 1023px) calc(10.5rem - 1.3rem - 2px), calc(14rem - 1.3rem - 2px)';

  return (
    <section className={styles.section} aria-labelledby={headingId}>
      <h2 className={styles.title} id={headingId}>{title}</h2>
      {items.length === 0 ? (
        <p className={styles.empty}>No music is available in this section yet.</p>
      ) : (
        <>
          {presentation === 'carousel' && (
            <p className={styles.visuallyHidden} id={carouselHelpId}>
              Scroll horizontally to explore this carousel.
            </p>
          )}
          <ul
            aria-describedby={presentation === 'carousel' ? carouselHelpId : undefined}
            aria-label={presentation === 'carousel' ? `${title} carousel` : undefined}
            className={styles[presentation]}
            data-presentation={presentation}
            tabIndex={presentation === 'carousel' ? 0 : undefined}
          >
            {presentation === 'list'
              ? items.map((item) => <ContentListRow item={item} key={`${item.contentType}:${item.id}`} onPlay={onPlay} />)
              : items.map((item) => (
                <li className={styles.cardItem} key={`${item.contentType}:${item.id}`}>
                  <ContentCard artworkSizes={cardArtworkSizes} item={item} onPlay={onPlay} />
                </li>
              ))}
          </ul>
        </>
      )}
    </section>
  );
};
