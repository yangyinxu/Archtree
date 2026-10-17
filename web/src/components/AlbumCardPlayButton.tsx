import { useQueryClient } from '@tanstack/react-query';
import { Play } from 'lucide-react';
import { useState } from 'react';

import { contentByline, type AlbumSummary } from '../api/contentSchemas';
import { listenerAlbumQuery } from '../api/listener';
import type { BrowserSession } from '../api/schemas';
import { browserSessionQuery } from '../api/session';
import { launchAlbumPlaybackAfterLoad } from '../features/playback/launchPlayback';
import { useLocalization } from '../localization/LocalizationProvider';
import styles from './ContentCard.module.css';

type AlbumCardPlayStatus = 'idle' | 'loading' | 'empty' | 'failed' | 'roomActive';

export interface AlbumCardPlayButtonProps {
  album: AlbumSummary;
  title: string;
}

/**
 * Starts an Album from its card without leaving the current route. It is a sibling of the
 * card's Album link, never nested inside it, and uses the same canonical ready-only queue and
 * Recently Played policy as the Album page Play button.
 */
export const AlbumCardPlayButton = ({ album, title }: AlbumCardPlayButtonProps) => {
  const queryClient = useQueryClient();
  const { t } = useLocalization();
  const [status, setStatus] = useState<AlbumCardPlayStatus>('idle');
  // An offline browser must fail now rather than pause the load and start playback later.
  const albumQuery = { ...listenerAlbumQuery(album.id), networkMode: 'always' as const };
  const byline = contentByline(album);

  // Warming the Album on pointer or keyboard intent keeps the click inside the browser's
  // user-activation window, so starting playback is not treated as autoplay.
  const prefetch = () => {
    void queryClient.prefetchQuery(albumQuery);
  };

  const play = async () => {
    if (status === 'loading') return;
    setStatus('loading');
    // Read without subscribing: every card would otherwise observe the session query.
    const viewerId = queryClient.getQueryData<BrowserSession | null>(browserSessionQuery().queryKey)?.user.id;
    try {
      const result = await launchAlbumPlaybackAfterLoad(
        album.id,
        async () => (await queryClient.ensureQueryData(albumQuery)).tracks,
        viewerId
      );
      setStatus(result === 'empty' || result === 'roomActive' ? result : 'idle');
    } catch {
      // A failed or timed-out load leaves the current player untouched; the Album page stays reachable.
      setStatus('failed');
    }
  };

  return (
    <span className={styles.artworkOverlay}>
      <button
        aria-busy={status === 'loading' ? 'true' : undefined}
        aria-label={byline
          ? t('content.album.play_byline_label', { title, byline })
          : t('content.album.play_label', { title })}
        className={styles.playReveal}
        onClick={() => { void play(); }}
        onFocus={prefetch}
        onPointerEnter={prefetch}
        type="button"
      >
        <Play aria-hidden="true" fill="currentColor" focusable="false" strokeWidth={1.8} />
      </button>
      <span className="visually-hidden" role="status">
        {status === 'empty'
          ? t('catalog.album.empty')
          : status === 'failed'
            ? t('content.album.play_failed', { title })
            : status === 'roomActive'
              ? t('content.album.play_room_active', { title })
              : ''}
      </span>
    </span>
  );
};
