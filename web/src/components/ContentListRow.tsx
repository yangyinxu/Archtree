import type { ReactNode } from 'react';
import { Link } from 'react-router';

import { contentByline, type AudioTrackSummary, type ContentSummary } from '../api/contentSchemas';
import { Artwork } from './Artwork';
import styles from './ContentListRow.module.css';
import { useLocalization } from '../localization/LocalizationProvider';

export interface ContentListRowProps {
  item: ContentSummary;
  onPlay?: (audioTrack: AudioTrackSummary) => void;
  trailing?: ReactNode;
}

/** Renders a canonical single-column row whose whole surface is the primary action. */
export const ContentListRow = ({ item, onPlay, trailing }: ContentListRowProps) => {
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
  const metadata = [
    type,
    item.contentType === 'artist' ? null : contentByline(item) || null,
    item.contentType === 'album' ? item.releaseDate?.year ?? null : null,
    item.contentType === 'audioTrack' ? item.albumTitle : null,
    item.contentType === 'audioTrack' ? item.duration : null
  ].filter((value) => value !== null && value !== '').join(' · ');
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
      {trailing && <span className={styles.trailing}>{trailing}</span>}
    </li>
  );
};
