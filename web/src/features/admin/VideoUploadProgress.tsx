import type { UploadProgress } from '../../api/client';
import { useAdminDeliveryText } from './adminPageText';
import styles from './VideoUpload.module.css';

const bytes = (value: number) => `${(value / 1024 ** 2).toFixed(1)} MiB`;

/** Browser byte completion still waits for the original operation's server receipt. */
export function VideoTransferProgress({ progress, kind }: { progress: UploadProgress; kind: 'source' | 'covers' }) {
  const t = useAdminDeliveryText(['video.']);
  const percent = progress.total !== null && progress.total > 0 ? Math.floor(Math.min(100, progress.loaded / progress.total * 100)) : null;
  const label = t(kind === 'source' ? 'video.transmitting' : 'video.transmitting_cover');
  return <div className={styles.progress}>
    <p role="status">{percent === 100 ? t('video.transfer_waiting') : label}</p>
    <div className={styles.progressMeta}>{percent !== null && <strong>{percent}%</strong>}<span className={styles.help}>{bytes(progress.loaded)}{progress.total !== null && ` / ${bytes(progress.total)}`}</span></div>
    <progress max={100} value={percent ?? undefined} aria-label={label} />
  </div>;
}

/** Each decoder phase reports its own measured work; unknown work has no invented percentage. */
export function VideoProcessingProgress({ progress }: { progress: number | null }) {
  const t = useAdminDeliveryText(['video.']);
  return <div className={styles.progress}>
    {progress !== null && <p><strong>{Math.floor(progress)}%</strong> · {t('video.processing_progress_help')}</p>}
    <progress max={100} value={progress ?? undefined} aria-label={t('video.stage_2')} />
  </div>;
}
