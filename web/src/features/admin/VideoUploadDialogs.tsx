import { useLayoutEffect, useRef, useState } from 'react';
import { ModalDialog } from '../../components/ModalDialog';
import { useAdminAccess } from './AdminAccess';
import { useAdminDeliveryText } from './adminPageText';
import { videoCoverUrl, type VideoProject } from './videoUploadApi';
import common from './adminStyles';
import styles from './VideoUpload.module.css';

/** A source change owns a fresh error state; settling an earlier source cannot reset or poison this preview. */
function LocalVideoPreview({ url }: { url: string }) {
  const t = useAdminDeliveryText(['video.']), video = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);
  useLayoutEffect(() => {
    // A tiny or unsupported source may have failed before the component finished mounting.
    if (video.current?.error) setFailed(true);
  }, []);
  return failed ? <p role="status">{t('video.preview_unavailable')}</p>
    : <video ref={video} className={styles.video} src={url} controls playsInline preload="metadata" onError={() => setFailed(true)} />;
}

/** Loads only after an explicit dialog action; every approval reads the captured server snapshot. */
export default function VideoUploadDialogs({ approval, current, disabled, ready, cancelling, previewUrl, onClose, onPublish, onCancel }: {
  approval: VideoProject | null; current: VideoProject; disabled: boolean; ready: boolean;
  cancelling: boolean; previewUrl: string | null; onClose: () => void;
  onPublish: (approval: VideoProject) => void; onCancel: () => void;
}) {
  const t = useAdminDeliveryText(['video.']), access = useAdminAccess(), close = useRef<HTMLButtonElement>(null);
  const selectedCover = approval?.covers.find(cover => cover.id === approval.selectedCoverId && cover.state === 'ready');
  const inheritedCover = selectedCover ? null : approval?.references.album?.coverUrl;
  const stale = approval && (approval.revision !== current.revision || approval.approvalDigest !== current.approvalDigest);
  return <>
    {approval && <ModalDialog title={t('video.confirm')} initialFocusRef={close} onClose={onClose}>
      <p>{t('video.confirm_help')}</p><dl className={styles.summary}>
        <div><dt>{t('video.title')}</dt><dd>{approval.draft.title}</dd></div>
        <div><dt>{t('video.attribution')}</dt><dd>{approval.draft.attribution === 'self' ? approval.draft.publicName || t('video.personal') : approval.references.subject?.name || t('video.attribution_unknown')}</dd></div>
        <div><dt>{t('video.album')}</dt><dd>{approval.references.album?.title || t('video.no_album')}</dd></div>
        <div><dt>{t('video.visibility')}</dt><dd>{t(`field.${approval.draft.visibility}`)}</dd></div>
        <div><dt>{t('video.cover')}</dt><dd>{selectedCover ? <><img src={videoCoverUrl(selectedCover.previewUrl, access.viewerId)} alt={t('video.cover_preview')} /><p>{selectedCover.name}</p></>
          : inheritedCover ? <><img src={videoCoverUrl(inheritedCover, access.viewerId)} alt={t('video.cover_preview')} /><p>{t('video.cover_inherited')}</p></> : t('video.cover_placeholder')}</dd></div>
        <div><dt>{t('video.file_processing')}</dt><dd>{approval.source.filename}</dd></div>
      </dl>
      <p className={styles.help}>{t('video.album_visibility_help')}</p>
      {approval.references.album?.visibility === 'hidden' && <p role="status">{t('video.album_hidden')}</p>}
      {stale && <p role="alert">{t('video.stale')}</p>}
      <div className={common.dialogActions}><button ref={close} className={common.button} type="button" onClick={onClose}>{t('common.cancel')}</button>
        <button className={`${common.button} ${common.primary}`} type="button" disabled={disabled || !ready || Boolean(stale)} onClick={() => onPublish(approval)}>{t(approval.draft.visibility === 'hidden' ? 'video.confirm_hidden' : 'video.confirm_publish')}</button>
      </div>
    </ModalDialog>}
    {cancelling && <ModalDialog title={t('video.cancel')} description={t('video.cancel_help')} initialFocusRef={close} onClose={onClose}>
      <div className={common.dialogActions}><button ref={close} className={common.button} type="button" onClick={onClose}>{t('common.cancel')}</button><button className={common.button} type="button" disabled={disabled} onClick={onCancel}>{t('video.cancel_confirm')}</button></div>
    </ModalDialog>}
    {previewUrl && <ModalDialog title={t('video.preview')} initialFocusRef={close} onClose={onClose} wide>
      <LocalVideoPreview key={previewUrl} url={previewUrl} />
      <p className={styles.help}>{t('video.local_preview_help')}</p><button ref={close} className={common.button} onClick={onClose}>{t('common.cancel')}</button>
    </ModalDialog>}
  </>;
}
