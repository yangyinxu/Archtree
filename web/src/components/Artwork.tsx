import { useEffect, useState } from 'react';
import { Disc3, Music2, UserRound, type LucideIcon } from 'lucide-react';

import type { ContentSummary } from '../api/contentSchemas';
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
}

/** Preserves artwork geometry and replaces missing or failed images predictably. */
export const Artwork = ({
  src,
  alt,
  kind,
  className = '',
  loading = 'lazy'
}: ArtworkProps) => {
  const normalizedSource = src?.trim() ?? '';
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const hasImage = normalizedSource.length > 0 && failedSource !== normalizedSource;
  const FallbackIcon = fallbackIcons[kind];

  useEffect(() => {
    if (failedSource && failedSource !== normalizedSource) setFailedSource(null);
  }, [failedSource, normalizedSource]);

  return (
    <span
      className={`${styles.artwork} ${kind === 'artist' ? styles.artist : ''} ${className}`.trim()}
      {...(!hasImage && alt ? { role: 'img', 'aria-label': alt } : {})}
      {...(!hasImage && !alt ? { 'aria-hidden': true } : {})}
    >
      {hasImage ? (
        <img
          alt={alt}
          decoding="async"
          loading={loading}
          onError={() => setFailedSource(normalizedSource)}
          src={normalizedSource}
        />
      ) : (
        <FallbackIcon aria-hidden="true" focusable="false" strokeWidth={1.5} />
      )}
    </span>
  );
};
