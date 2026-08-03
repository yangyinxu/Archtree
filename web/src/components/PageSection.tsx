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
                  <ContentCard item={item} onPlay={onPlay} />
                </li>
              ))}
          </ul>
        </>
      )}
    </section>
  );
};
