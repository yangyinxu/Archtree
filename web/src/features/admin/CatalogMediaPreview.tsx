import { useEffect, useRef } from 'react';
import { useAdminAccess, useAdminText } from './AdminAccess';
import type { CatalogItem } from './catalogApi';
import { useAdminDeliveryText } from './adminPageText';
import styles from './CatalogMediaPreview.module.css';

/** A keyed native element owns its private source until its account or saved catalog identity changes. */
function CatalogMediaElement({ item, viewerId, label }: { item: CatalogItem; viewerId: string; label: string }) {
  const media = useRef<HTMLMediaElement | null>(null);
  const source = `${item.mediaUrl}?viewer=${encodeURIComponent(viewerId)}`;
  useEffect(() => {
    const element = media.current;
    return () => { if (element) { element.pause(); element.removeAttribute('src'); element.load(); } };
  }, []);
  return item.kind === 'audioTrack' && item.mediaType === 'video'
    ? <video ref={element => { media.current = element; }} className={styles.video} aria-label={label} controls playsInline preload="metadata"
      src={source} poster={item.coverUrl ? `${item.coverUrl}?viewer=${encodeURIComponent(viewerId)}` : undefined} />
    : <audio ref={element => { media.current = element; }} aria-label={label} controls preload="none" src={source} style={{ maxWidth: '100%' }} />;
}

/** Video administration copy stays in its Web-only delivery bundle. */
function CatalogVideoMedia({ item, viewerId }: { item: CatalogItem; viewerId: string }) {
  const t = useAdminDeliveryText(['video.']);
  return <CatalogMediaElement item={item} viewerId={viewerId} label={t('video.published_preview')} />;
}

/** Catalog and completed-upload views share the current administrator's saved Audio or Video preview. */
export function CatalogMediaPreview({ item, refresh = 0 }: { item: CatalogItem | null; refresh?: number }) {
  const access = useAdminAccess(), t = useAdminText();
  if (!access.active || !item?.mediaUrl) return null;
  const type = item.kind === 'audioTrack' ? item.mediaType ?? 'audio' : 'audio';
  const key = `${access.viewerId}:${access.epoch}:${access.generation}:${item.kind}:${item.id}:${item.revision}:${item.mediaUrl}:${type}:${refresh}`;
  return type === 'video' ? <CatalogVideoMedia key={key} item={item} viewerId={access.viewerId} />
    : <CatalogMediaElement key={key} item={item} viewerId={access.viewerId} label={t('catalog.preview')} />;
}
