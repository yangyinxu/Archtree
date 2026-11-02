import { lazy, Suspense, useRef, useState } from 'react';
import { useAdminAccess } from './AdminAccess';
import { useAdminDeliveryText } from './adminPageText';
import { videoCoverUrl, type VideoDraft, type VideoProject } from './videoUploadApi';
import common from './adminStyles';
import styles from './VideoUpload.module.css';

const VideoFramePicker = lazy(() => import('./VideoFramePicker'));

/** Shows server-confirmed artwork; manual images and real decoded frames remain optional replacements. */
export function VideoUploadCover({ project, draft, localUrl, disabled, onImage, onChoice, onFrame }: {
  project: VideoProject; draft: VideoDraft; localUrl: string | null; disabled: boolean;
  onImage: (file: File) => void; onChoice: (value: string) => void; onFrame: (time: number) => void;
}) {
  const t = useAdminDeliveryText(['video.']), access = useAdminAccess(), image = useRef<HTMLInputElement>(null);
  const [picking, setPicking] = useState(false);
  const selected = project.covers.find(cover => cover.id === (draft.coverChoice === 'automatic' ? project.selectedCoverId : draft.coverChoice) && cover.state === 'ready');
  const published = project.publication.state === 'complete' ? project.publication.coverUrl : null;
  const inherited = selected || published ? null : project.references.album?.coverUrl;
  return <section className={common.panel}><h2>{t('video.cover')}</h2><div className={styles.cover}>
    {(published || selected || inherited) && <img src={videoCoverUrl(published || selected?.previewUrl || inherited!, access.viewerId)} alt={t('video.cover_preview')} />}
    <div><strong>{published ? t('video.cover_published') : selected ? selected.name : t(inherited ? 'video.cover_inherited' : 'video.cover_placeholder')}</strong><p className={styles.help}>{t('video.cover_help')}</p>
      <div className={common.actions}><button className={common.button} type="button" disabled={disabled} onClick={() => image.current?.click()}>{t('video.cover_upload')}</button>
        <button className={common.button} type="button" disabled={disabled || !localUrl || project.source.status !== 'ready'} onClick={() => setPicking(true)}>{t('video.cover_frame')}</button>
        {draft.coverChoice !== 'automatic' && <button className={common.button} type="button" disabled={disabled} onClick={() => onChoice('automatic')}>{t('video.cover_automatic')}</button>}
        {draft.coverChoice !== 'none' && <button className={common.button} type="button" disabled={disabled} onClick={() => onChoice('none')}>{t('video.cover_none')}</button>}
      </div><input ref={image} hidden type="file" accept="image/jpeg,image/png,image/webp" disabled={disabled} onChange={event => { if (event.target.files?.[0]) onImage(event.target.files[0]); event.target.value = ''; }} />
    </div></div>
    {project.frame.state === 'failed' && <p role="status">{t('video.frame_failed')}</p>}
    {!localUrl && <p className={styles.help}>{t('video.frame_local_needed')}</p>}
    {picking && localUrl && <Suspense fallback={<p role="status">{t('common.loading')}</p>}><VideoFramePicker url={localUrl} onClose={() => setPicking(false)} onChoose={time => { onFrame(time); setPicking(false); }} /></Suspense>}
  </section>;
}

