import { useEffect, useRef, useState } from 'react';
import { ModalDialog } from '../../components/ModalDialog';
import { useAdminDeliveryText } from './adminPageText';
import { captureVideoFrame, videoCandidateTime, type VideoFrame } from './videoFrame';
import common from './adminStyles';
import styles from './VideoUpload.module.css';

/** Selects only a frame actually decoded by this browser; local decode failure never blocks source upload. */
export default function VideoFramePicker({ url, onClose, onChoose }: { url: string; onClose: () => void; onChoose: (time: number) => void }) {
  const t = useAdminDeliveryText(['video.']), video = useRef<HTMLVideoElement>(null), close = useRef<HTMLButtonElement>(null), sequence = useRef(0);
  const [duration, setDuration] = useState(0), [time, setTime] = useState(0), [frame, setFrame] = useState<(VideoFrame & { url: string }) | null>(null);
  const [error, setError] = useState(false), [loading, setLoading] = useState(true), [playing, setPlaying] = useState(false);
  useEffect(() => () => { sequence.current += 1; }, []);
  useEffect(() => () => { if (frame) URL.revokeObjectURL(frame.url); }, [frame]);
  const capture = async () => {
    const element = video.current;
    if (!element || element.seeking || element.readyState < 2) return;
    const request = ++sequence.current; setLoading(true);
    try {
      const result = await captureVideoFrame(element);
      if (request !== sequence.current || element.seeking || Math.abs(element.currentTime - result.time) > .05) return;
      setFrame({ ...result, url: URL.createObjectURL(result.blob) }); setTime(result.time); setError(false);
    } catch { if (request === sequence.current) setError(true); }
    finally { if (request === sequence.current) setLoading(false); }
  };
  return <ModalDialog title={t('video.cover_frame')} initialFocusRef={close} onClose={onClose} wide>
    <video ref={video} className={styles.video} src={url} controls playsInline preload="metadata" onLoadedMetadata={() => {
      const value = video.current?.duration ?? 0;
      if (!Number.isFinite(value) || value <= 0) { setError(true); setLoading(false); return; }
      setDuration(value); setTime(videoCandidateTime(value)); video.current!.currentTime = videoCandidateTime(value);
    }} onLoadedData={() => void capture()} onSeeked={() => void capture()} onPlay={() => setPlaying(true)} onPause={() => { setPlaying(false); void capture(); }} onTimeUpdate={() => { if (video.current && !video.current.paused) setTime(video.current.currentTime); }} onError={() => { sequence.current += 1; setError(true); setLoading(false); setFrame(null); }} />
    <label className={common.field}>{t('video.frame_time')} · {time.toFixed(2)} / {duration.toFixed(2)}<input className={styles.range} type="range" min={0} max={Math.max(0, duration - .01)} step={.01} value={time} disabled={!duration || error} onChange={event => { sequence.current += 1; const value = Number(event.target.value); setTime(value); setFrame(null); setLoading(true); video.current!.pause(); video.current!.currentTime = value; }} /></label>
    {frame && <img className={styles.video} src={frame.url} alt={t('video.frame_preview')} />}
    {loading && <p role="status">{t('common.loading')}</p>}{error && <p role="status">{t('video.preview_unavailable')}</p>}
    <div className={common.dialogActions}><button ref={close} type="button" className={common.button} onClick={onClose}>{t('common.cancel')}</button><button type="button" className={`${common.button} ${common.primary}`} disabled={!frame || loading || playing || error || Math.abs(frame.time - time) > .05} onClick={() => { if (frame) onChoose(frame.time); }}>{t('video.frame_use')}</button></div>
  </ModalDialog>;
}
