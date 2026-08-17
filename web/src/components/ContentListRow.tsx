import type { ReactNode } from 'react';
import { Link } from 'react-router';

import { contentByline, type AudioTrackSummary, type ContentSummary } from '../api/contentSchemas';
import { Artwork } from './Artwork';
import styles from './ContentListRow.module.css';

const titleFor = (item: ContentSummary) => item.contentType === 'artist'
  ? item.name.trim() || 'Unknown artist'
  : item.title.trim() || (item.contentType === 'album' ? 'Untitled album' : 'Untitled soundtrack');

const metadataFor = (item: ContentSummary) => {
  if (item.contentType === 'artist') return ['Artist'];
  if (item.contentType === 'album') {
    return ['Album', contentByline(item) || null, item.releaseDate?.year ?? null];
  }
  return ['Soundtrack', contentByline(item) || null, item.albumTitle, item.duration];
};

export interface ContentListRowProps {
  item: ContentSummary;
  onPlay?: (audioTrack: AudioTrackSummary) => void;
  trailing?: ReactNode;
}

/** Renders a canonical single-column row whose whole surface is the primary action. */
export const ContentListRow = ({ item, onPlay, trailing }: ContentListRowProps) => {
  const title = titleFor(item);
  const metadata = metadataFor(item).filter((value) => value !== null && value !== '').join(' · ');
  const body = (
    <>
      <Artwork alt="" className={styles.artwork} kind={item.contentType} sizes="3.15rem" src={item.artworkUrl} />
      <span className={styles.copy}>
        <span className={styles.title} title={title}>{title}</span>
        <span className={styles.metadata}>{metadata}</span>
      </span>
    </>
  );

  return (
    <li className={styles.row}>
      {item.contentType === 'audioTrack' ? (
        onPlay ? (
          <button
            aria-label={`Play ${title}${contentByline(item) ? ` by ${contentByline(item)}` : ''}`}
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
      {trailing && <span className={styles.trailing}>{trailing}</span>}
    </li>
  );
};
