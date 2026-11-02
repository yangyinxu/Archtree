import { useLayoutEffect, useRef, useState } from 'react';
import { ModalDialog } from '../../components/ModalDialog';
import { useAdminDeliveryText } from './adminPageText';
import { captureVideoFrame, videoCandidateTime, type VideoFrame } from './videoFrame';
import common from './adminStyles';
import styles from './VideoUpload.module.css';

interface VideoFramePickerProps { url: string; onClose: () => void; onChoose: (time: number) => void; onCapture?: (frame: VideoFrame) => void; unavailableMessage?: string }

/** Each source owns its decoded state and pending captures, including media that settled before mount. */
function VideoFramePickerSource({ url, onClose, onChoose, onCapture, unavailableMessage }: VideoFramePickerProps) {
  const t = useAdminDeliveryText(['video.']), video = useRef<HTMLVideoElement>(null), close = useRef<HTMLButtonElement>(null);
  const sequence = useRef(0), active = useRef(false), initialized = useRef(false), previewUrl = useRef<string | null>(null);
  const [duration, setDuration] = useState(0), [time, setTime] = useState(0), [frame, setFrame] = useState<(VideoFrame & { url: string }) | null>(null);
  const [error, setError] = useState(false), [loading, setLoading] = useState(true), [playing, setPlaying] = useState(false);
  const clearFrame = () => {
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
    previewUrl.current = null; setFrame(null);
  };
  const fail = () => {
    if (!active.current) return;
    sequence.current += 1; clearFrame(); setError(true); setLoading(false); setPlaying(false);
  };
  const capture = async () => {
    const element = video.current;
    if (!active.current || !element || element.seeking || element.readyState < 2) return;
    const request = ++sequence.current; setLoading(true);
    try {
      const result = await captureVideoFrame(element);
      if (!active.current || request !== sequence.current || element !== video.current || element.seeking || Math.abs(element.currentTime - result.time) > .05) return;
      const nextUrl = URL.createObjectURL(result.blob);
      if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
      previewUrl.current = nextUrl; setFrame({ ...result, url: nextUrl }); setTime(result.time); setError(false);
    } catch { if (active.current && request === sequence.current) fail(); }
    finally { if (active.current && request === sequence.current) setLoading(false); }
  };
  const synchronize = () => {
    const element = video.current;
    if (!active.current || !element) return;
    if (element.error) { fail(); return; }
    if (element.readyState < 1) return;
    const value = element.duration;
    if (!Number.isFinite(value) || value <= 0) { fail(); return; }
    setDuration(value); setPlaying(!element.paused);
    if (!initialized.current) {
      initialized.current = true;
      // Duplicate metadata events must preserve a frame chosen through the slider or native controls.
      if (element.paused && element.currentTime === 0) {
        try { element.currentTime = videoCandidateTime(value); } catch { fail(); return; }
      }
    }
    setTime(element.currentTime); void capture();
  };
  useLayoutEffect(() => {
    active.current = true; synchronize();
    return () => {
      active.current = false; sequence.current += 1;
      if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
      previewUrl.current = null;
    };
  }, []);
  const seek = (value: number) => {
    const element = video.current;
    if (!active.current || !element) return;
    sequence.current += 1; clearFrame(); setTime(value); setLoading(true); element.pause();
    try { element.currentTime = value; void capture(); } catch { fail(); }
  };
  // The native end position can be previewed, but the server admits frames strictly before duration.
  const selectable = frame !== null && Number.isFinite(time) && time >= 0 && time < duration
    && Number.isFinite(frame.time) && frame.time >= 0 && frame.time < duration;
  return <ModalDialog title={t('video.cover_frame')} initialFocusRef={close} onClose={onClose} wide>
    <video ref={video} className={styles.video} src={url} controls playsInline preload="metadata" onLoadedMetadata={synchronize}
      onLoadedData={synchronize} onSeeked={synchronize} onPlay={() => setPlaying(true)} onPause={synchronize}
      onSeeking={() => { sequence.current += 1; clearFrame(); setLoading(true); }}
      onTimeUpdate={() => { if (video.current && !video.current.paused) setTime(video.current.currentTime); }} onError={fail} />
    <label className={common.field}>{t('video.frame_time')} · {time.toFixed(2)} / {duration.toFixed(2)}<input className={styles.range} type="range" min={0} max={Math.max(0, duration - .01)} step={.01} value={time} disabled={!duration || error} onChange={event => seek(Number(event.target.value))} /></label>
    {frame && <img className={styles.video} src={frame.url} alt={t('video.frame_preview')} />}
    {loading && <p role="status">{t('common.loading')}</p>}{error && <p role="status">{unavailableMessage ?? t('video.preview_unavailable')}</p>}
    <div className={common.dialogActions}><button ref={close} type="button" className={common.button} onClick={onClose}>{t('common.cancel')}</button><button type="button" className={`${common.button} ${common.primary}`} disabled={!frame || !selectable || loading || playing || error || Math.abs(frame.time - time) > .05} onClick={() => { if (frame && selectable) { if (onCapture) onCapture(frame); else onChoose(frame.time); } }}>{t('video.frame_use')}</button></div>
  </ModalDialog>;
}

/** Local decode failure never blocks upload; a changed source cannot inherit another video's selection. */
export default function VideoFramePicker(props: VideoFramePickerProps) { return <VideoFramePickerSource key={props.url} {...props} />; }
