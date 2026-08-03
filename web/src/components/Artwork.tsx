import { useEffect, useState } from 'react';
import { Disc3, Music2, UserRound, type LucideIcon } from 'lucide-react';

import type { ContentSummary } from '../api/contentSchemas';
import { responsiveArtworkSrcSet } from '../artwork/artworkUrls';
import styles from './Artwork.module.css';

export type ArtworkKind = ContentSummary['contentType'];

const fallbackIcons: Record<ArtworkKind, LucideIcon> = {
  artist: UserRound,
  album: Disc3,
  audioTrack: Music2
};

export interface ArtworkProps {
  src?: string | null;
  alt: string;
  kind: ArtworkKind;
  className?: string;
  loading?: 'eager' | 'lazy';
  sizes?: string;
  fetchPriority?: 'high' | 'low' | 'auto';
}

/** Preserves artwork geometry and replaces missing or failed images predictably. */
export const Artwork = ({
  src,
  alt,
  kind,
  className = '',
  loading = 'lazy',
  sizes,
  fetchPriority
}: ArtworkProps) => {
  const normalizedSource = src?.trim() ?? '';
  const srcSet = responsiveArtworkSrcSet(normalizedSource);
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const [retryOriginalSource, setRetryOriginalSource] = useState<string | null>(null);
  const hasImage = normalizedSource.length > 0 && failedSource !== normalizedSource;
  const retryingOriginal = retryOriginalSource === normalizedSource;
  const FallbackIcon = fallbackIcons[kind];

  useEffect(() => {
    if (failedSource && failedSource !== normalizedSource) setFailedSource(null);
    if (retryOriginalSource && retryOriginalSource !== normalizedSource) {
      setRetryOriginalSource(null);
    }
  }, [failedSource, normalizedSource, retryOriginalSource]);

  return (
    <span
      className={`${styles.artwork} ${kind === 'artist' ? styles.artist : ''} ${className}`.trim()}
      {...(!hasImage && alt ? { role: 'img', 'aria-label': alt } : {})}
      {...(!hasImage && !alt ? { 'aria-hidden': true } : {})}
    >
      {hasImage ? (
        <img
          key={retryingOriginal ? 'original' : 'responsive'}
          alt={alt}
          decoding="async"
          fetchPriority={fetchPriority}
          loading={loading}
          onError={() => {
            if (srcSet && !retryingOriginal) {
              setRetryOriginalSource(normalizedSource);
              return;
            }
            setFailedSource(normalizedSource);
          }}
          sizes={srcSet && !retryingOriginal ? sizes : undefined}
          src={normalizedSource}
          srcSet={srcSet && !retryingOriginal ? srcSet : undefined}
        />
      ) : (
        <FallbackIcon aria-hidden="true" focusable="false" strokeWidth={1.5} />
      )}
    </span>
  );
};
