import { Link } from 'react-router';
import { Play } from 'lucide-react';

import type { AudioTrackSummary, ContentSummary } from '../api/contentSchemas';
import { Artwork } from './Artwork';
import styles from './ContentCard.module.css';

const contentTitle = (item: ContentSummary) => {
  if (item.contentType === 'artist') return item.name.trim() || 'Unknown artist';
  if (item.contentType === 'album') return item.title.trim() || 'Untitled album';
  return item.title.trim() || 'Untitled soundtrack';
};

const contentMetadata = (item: ContentSummary) => {
  if (item.contentType === 'artist') return 'Artist';
  if (item.contentType === 'album') {
    return [
      'Album',
      item.artistNames.join(', ') || null,
      item.releaseDate?.year ? String(item.releaseDate.year) : null
    ].filter(Boolean).join(' · ');
  }
  return [
    'Soundtrack',
    item.artistNames.join(', ') || null,
    item.albumTitle,
    item.duration
  ].filter(Boolean).join(' · ');
};

export interface ContentCardProps {
  item: ContentSummary;
  onPlay?: (audioTrack: AudioTrackSummary) => void;
  artworkSizes?: string;
}

// Subtract the action's inline padding and border from each outer grid-card width.
export const defaultContentCardArtworkSizes = '(max-width: 400px) calc(100vw - 3.3rem - 2px), (max-width: 480px) calc((100vw - 2.75rem) / 2 - 1.3rem - 2px), (max-width: 1023px) calc(10.5rem - 1.3rem - 2px), calc(14rem - 1.3rem - 2px)';

/** Presents one content summary with a single, non-overlapping primary action. */
export const ContentCard = ({
  item,
  onPlay,
  artworkSizes = defaultContentCardArtworkSizes
}: ContentCardProps) => {
  const title = contentTitle(item);
  const metadata = contentMetadata(item);
  const showPlayReveal = item.contentType === 'audioTrack' && Boolean(onPlay);
  const body = (
    <>
      <span className={styles.artworkFrame}>
        <Artwork alt="" kind={item.contentType} sizes={artworkSizes} src={item.artworkUrl} />
        {showPlayReveal ? (
          <span aria-hidden="true" className={styles.playReveal}>
            <Play fill="currentColor" focusable="false" strokeWidth={1.8} />
          </span>
        ) : null}
      </span>
      <span className={styles.copy}>
        <span className={styles.title} title={title}>{title}</span>
        <span className={styles.metadata}>{metadata}</span>
      </span>
    </>
  );

  return (
    <article className={styles.card}>
      {item.contentType === 'audioTrack' ? (
        onPlay ? (
          <button
            aria-label={`Play ${title}${item.artistNames.length ? ` by ${item.artistNames.join(', ')}` : ''}`}
            className={styles.action}
            onClick={() => onPlay(item)}
            type="button"
          >
            {body}
          </button>
        ) : (
          <div className={styles.action}>{body}</div>
        )
      ) : (
        <Link
          aria-label={`${title}, ${item.contentType === 'artist' ? 'artist' : 'album'}`}
          className={styles.action}
          to={`/${item.contentType === 'artist' ? 'artists' : 'albums'}/${encodeURIComponent(item.id)}`}
        >
          {body}
        </Link>
      )}
    </article>
  );
};
