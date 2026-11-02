import { useEffect, useRef, type RefObject } from 'react';
import { Expand } from 'lucide-react';

import { formatLocalizedMessage, useLocalization } from '../../localization/LocalizationProvider';
import { videoTextFor } from './videoText';
import styles from './VideoPreviewCard.module.css';

export interface VideoFrameOptionsProps {
  id: string;
  title: string;
  fit: 'cover' | 'contain';
  position: number;
  onFit: (fit: 'cover' | 'contain') => void;
  onPosition: (position: number) => void;
  onClose: (restoreFocus?: boolean) => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
}

/** Loads local framing controls only when requested and restores the disclosure's keyboard focus. */
export default function VideoFrameOptions({ id, title, fit, position, onFit, onPosition, onClose, triggerRef }: VideoFrameOptionsProps) {
  const { locale } = useLocalization();
  const text = videoTextFor(locale, formatLocalizedMessage);
  const options = useRef<HTMLDivElement>(null);
  const fitButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    fitButton.current?.focus();
    const outside = (event: Event) => {
      const target = event.target as Node;
      if (!options.current?.contains(target) && !triggerRef.current?.contains(target)) onClose(false);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
    };
  }, [onClose, triggerRef]);
  return <div aria-label={text('videos.card.options', { title })} className={styles.options} id={id}
    onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
    }} ref={options} role="dialog">
    <button onClick={() => { onFit(fit === 'cover' ? 'contain' : 'cover'); onClose(); }} ref={fitButton} type="button">
      <Expand aria-hidden="true" size={17} />{text(fit === 'cover' ? 'videos.card.full_frame' : 'videos.card.fill')}
    </button>
    <label className={styles.crop}>
      <span>{text('videos.card.frame_position')}</span>
      <input aria-label={text('videos.card.frame_position_label', { title })} disabled={fit === 'contain'} max="100" min="0"
        onChange={(event) => onPosition(Number(event.target.value))} type="range" value={position} />
      <span className={styles.cropLabels}><span>{text('videos.card.left')}</span><span>{text('videos.card.right')}</span></span>
    </label>
  </div>;
}
