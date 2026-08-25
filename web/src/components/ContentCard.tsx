import { Link } from 'react-router';
import { Play } from 'lucide-react';

import { contentByline, type AudioTrackSummary, type ContentSummary } from '../api/contentSchemas';
import { Artwork } from './Artwork';
import styles from './ContentCard.module.css';
import { useLocalization } from '../localization/LocalizationProvider';


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
  const { locale, t } = useLocalization();
  const title = item.contentType === 'artist'
    ? item.name.trim() || t('content.title.unknown_artist')
    : item.title.trim() || (item.contentType === 'album'
      ? t('content.title.untitled_album')
      : t('content.title.untitled_track'));
  const type = item.contentType === 'artist'
    ? t('common.label.artist')
    : item.contentType === 'album'
      ? t('common.label.album')
      : t('common.label.mediatrack');
  const byline = item.contentType === 'artist' ? '' : contentByline(item);
  const metadata = [
    type,
    byline || null,
    item.contentType === 'album'
      ? item.releaseDate?.year ? String(item.releaseDate.year) : null
      : item.contentType === 'audioTrack' ? item.albumTitle : null,
    item.contentType === 'audioTrack' ? item.duration : null
  ].filter(Boolean).join(' · ');
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
            aria-label={contentByline(item)
              ? t('content.play.byline_label', { title, byline: contentByline(item) })
              : t('content.play.label', { title })}
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
          aria-label={t('content.link.label', { title, type: type.toLocaleLowerCase(locale) })}
          className={styles.action}
          to={`/${item.contentType === 'artist' ? 'artists' : 'albums'}/${encodeURIComponent(item.id)}`}
        >
          {body}
        </Link>
      )}
    </article>
  );
};
