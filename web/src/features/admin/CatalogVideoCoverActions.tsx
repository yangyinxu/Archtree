import type { RefObject } from 'react';
import { useAdminDeliveryText } from './adminPageText';
import styles from './adminStyles';

/** Published Video edits use current catalog media and the normal, separately confirmed cover lifecycle. */
export default function CatalogVideoCoverActions({ disabled, canFrame, canClear, uploadRef, onUpload, onFrame, onClear }: {
  disabled: boolean; canFrame: boolean; canClear: boolean; uploadRef: RefObject<HTMLButtonElement | null>;
  onUpload: () => void; onFrame: (unavailableMessage: string) => void; onClear: () => void;
}) {
  const t = useAdminDeliveryText(['video.']);
  return <>
    <button ref={uploadRef} className={styles.button} disabled={disabled} onClick={onUpload}>{t('video.cover_upload')}</button>
    <button className={styles.button} disabled={disabled || !canFrame} onClick={() => onFrame(t('video.published_preview_unavailable'))}>{t('video.cover_frame')}</button>
    <button className={styles.button} disabled={disabled || !canClear} onClick={onClear}>{t('video.cover_none')}</button>
  </>;
}
