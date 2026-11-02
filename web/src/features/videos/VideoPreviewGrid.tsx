import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';

import type { AudioTrackSummary } from '../../api/contentSchemas';
import { saveStatusesQuery } from '../../api/listener';
import { formatLocalizedMessage, useLocalization } from '../../localization/LocalizationProvider';
import { VideoPreviewCard } from './VideoPreviewCard';
import { videoTextFor } from './videoText';
import styles from './VideosPage.module.css';

export interface VideoPreviewGridProps {
  items: AudioTrackSummary[];
  viewerId?: string | null;
  onPlay: (track: AudioTrackSummary) => void;
}

/** Loads account-scoped Save state only while the optional immersive view is in use. */
export default function VideoPreviewGrid({ items, viewerId, onPlay }: VideoPreviewGridProps) {
  const { t, locale } = useLocalization();
  const text = videoTextFor(locale, formatLocalizedMessage);
  const targets = useMemo(() => items.map((item) => ({ contentType: 'audioTrack' as const, contentId: item.id })), [items]);
  const statuses = useQuery(saveStatusesQuery(viewerId ?? '', targets));
  const savedById = useMemo(() => new Map(statuses.data?.items.map((item) => [item.contentId, item.saved]) ?? []), [statuses.data]);
  return (
    <section aria-label={t('common.label.video')}>
      {items.length ? <ul aria-label={text('videos.preview.list')} className={styles.immersiveGrid}>
        {items.map((item) => <li key={item.id}>
          <VideoPreviewCard item={item} onPlay={onPlay}
            saved={!viewerId ? false : statuses.isError ? null : savedById.get(item.id) ?? null} viewerId={viewerId} />
        </li>)}
      </ul> : <p className={styles.empty}>{t('page_section.empty')}</p>}
    </section>
  );
}
