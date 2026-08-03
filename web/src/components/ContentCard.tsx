import { Link } from 'react-router';

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
}

/** Presents one content summary with a single, non-overlapping primary action. */
export const ContentCard = ({ item, onPlay }: ContentCardProps) => {
  const title = contentTitle(item);
  const metadata = contentMetadata(item);
  const body = (
    <>
      <Artwork alt="" kind={item.contentType} src={item.artworkUrl} />
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
