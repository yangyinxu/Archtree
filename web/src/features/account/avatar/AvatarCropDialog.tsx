import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject
} from 'react';
import { X } from 'lucide-react';

import {
  avatarEditorSide,
  avatarOffsetLimits,
  clampAvatarTransform,
  drawAvatarEditor,
  renderAvatarCrop,
  type AvatarCropTransform,
  type AvatarImageSize
} from './avatarCrop';
import { useModalFocus } from './useModalFocus';
import styles from './AvatarSettings.module.css';

interface AvatarCropDialogProps {
  sourceUrl: string;
  onCancel: () => void;
  onUsePhoto: (jpeg: Blob) => void;
  returnFocusRef?: RefObject<HTMLButtonElement | null>;
  fallbackFocusRef?: RefObject<HTMLElement | null>;
}

const initialTransform: AvatarCropTransform = { zoom: 1, offsetX: 0, offsetY: 0 };

/** Owns the edit-to-preview transition so no upload can begin from the crop stage. */
export const AvatarCropDialog = ({
  sourceUrl,
  onCancel,
  onUsePhoto,
  returnFocusRef,
  fallbackFocusRef
}: AvatarCropDialogProps) => {
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const dragRef = useRef<{ x: number; y: number; transform: AvatarCropTransform } | null>(null);
  const mountedRef = useRef(true);
  const focusCropAfterPreviewRef = useRef(false);
  const [imageSize, setImageSize] = useState<AvatarImageSize | null>(null);
  const [transform, setTransform] = useState(initialTransform);
  const [preview, setPreview] = useState<{ blob: Blob; url: string } | null>(null);
  const [error, setError] = useState('');
  const [isPreparing, setIsPreparing] = useState(false);

  useModalFocus(dialogRef, closeButtonRef, returnFocusRef, fallbackFocusRef);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => {
      if (!image.naturalWidth || !image.naturalHeight
        || image.naturalWidth * image.naturalHeight > 16_000_000) {
        setError('Choose a photo with fewer than 16 million pixels.');
        return;
      }
      imageRef.current = image;
      setImageSize({ width: image.naturalWidth, height: image.naturalHeight });
    };
    image.onerror = () => setError('The selected photo could not be opened. Choose a JPG, PNG, or WebP photo.');
    image.src = sourceUrl;
    return () => {
      image.onload = null;
      image.onerror = null;
      imageRef.current = null;
    };
  }, [sourceUrl]);

  useEffect(() => {
    if (imageRef.current && canvasRef.current && imageSize) {
      drawAvatarEditor(canvasRef.current, imageRef.current, transform);
    }
  }, [imageSize, transform]);

  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview.url);
  }, [preview]);

  useEffect(() => {
    if (preview && !isPreparing) closeButtonRef.current?.focus();
  }, [isPreparing, preview]);

  useEffect(() => {
    if (!preview && focusCropAfterPreviewRef.current) {
      focusCropAfterPreviewRef.current = false;
      closeButtonRef.current?.focus();
    }
  }, [preview]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isPreparing) onCancel();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [isPreparing, onCancel]);

  const updateTransform = (next: AvatarCropTransform) => {
    if (!imageSize) return;
    setTransform(clampAvatarTransform(imageSize, next));
  };

  const startDrag = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!imageSize) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { x: event.clientX, y: event.clientY, transform };
  };

  const continueDrag = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!dragRef.current || !imageSize) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const coordinateScale = rect.width > 0 ? avatarEditorSide / rect.width : 1;
    updateTransform({
      ...dragRef.current.transform,
      offsetX: dragRef.current.transform.offsetX
        + (event.clientX - dragRef.current.x) * coordinateScale,
      offsetY: dragRef.current.transform.offsetY
        + (event.clientY - dragRef.current.y) * coordinateScale
    });
  };

  const endDrag = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
  };

  const preparePreview = async () => {
    if (!imageRef.current || isPreparing) return;
    setError('');
    setIsPreparing(true);
    try {
      const blob = await renderAvatarCrop(imageRef.current, transform);
      if (!mountedRef.current) return;
      setPreview({ blob, url: URL.createObjectURL(blob) });
    } catch (caught) {
      if (mountedRef.current) {
        setError(caught instanceof Error ? caught.message : 'The crop could not be prepared.');
      }
    } finally {
      if (mountedRef.current) setIsPreparing(false);
    }
  };

  const goBack = () => {
    if (preview) URL.revokeObjectURL(preview.url);
    focusCropAfterPreviewRef.current = true;
    setPreview(null);
  };

  const limits = imageSize ? avatarOffsetLimits(imageSize, transform.zoom) : { x: 0, y: 0 };

  return (
    <div className={styles.overlay} role="presentation">
      <section
        aria-describedby="avatar-editor-instructions"
        aria-labelledby="avatar-editor-title"
        aria-modal="true"
        className={styles.dialog}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className={styles.dialogHeader}>
          <div>
            <p className={styles.kicker}>{preview ? 'Final preview' : 'Square crop'}</p>
            <h2 id="avatar-editor-title">{preview ? 'Use this profile photo?' : 'Position your photo'}</h2>
          </div>
          <button aria-label="Cancel profile photo" className={styles.iconButton} disabled={isPreparing} onClick={onCancel} ref={closeButtonRef} type="button">
            <X aria-hidden="true" focusable="false" />
          </button>
        </div>

        {preview ? (
          <div className={styles.previewStage}>
            <img alt="Circular preview of the selected profile photo" className={styles.circularPreview} src={preview.url} />
            <p id="avatar-editor-instructions" className={styles.instructions}>
              This circular preview is what other account surfaces will show.
            </p>
            <div className={styles.dialogActions}>
              <button className={styles.secondaryButton} onClick={goBack} type="button">Back to crop</button>
              <button className={styles.primaryButton} onClick={() => onUsePhoto(preview.blob)} type="button">Use photo</button>
            </div>
          </div>
        ) : (
          <div className={styles.editorStage}>
            <canvas
              aria-label="Square profile photo crop. Drag to reposition."
              className={styles.cropCanvas}
              height={avatarEditorSide}
              onPointerCancel={endDrag}
              onPointerDown={startDrag}
              onPointerMove={continueDrag}
              onPointerUp={endDrag}
              ref={canvasRef}
              role="img"
              width={avatarEditorSide}
            />
            <p id="avatar-editor-instructions" className={styles.instructions}>
              Drag the image, then use the controls for precise position and scale.
            </p>
            <div className={styles.cropControls}>
              <label>
                <span>Zoom</span>
                <input
                  disabled={!imageSize}
                  max="4"
                  min="1"
                  onChange={(event) => updateTransform({ ...transform, zoom: Number(event.currentTarget.value) })}
                  step="0.01"
                  type="range"
                  value={transform.zoom}
                />
              </label>
              <label>
                <span>Horizontal position</span>
                <input
                  disabled={!imageSize || limits.x === 0}
                  max={limits.x}
                  min={-limits.x}
                  onChange={(event) => updateTransform({ ...transform, offsetX: Number(event.currentTarget.value) })}
                  step="1"
                  type="range"
                  value={transform.offsetX}
                />
              </label>
              <label>
                <span>Vertical position</span>
                <input
                  disabled={!imageSize || limits.y === 0}
                  max={limits.y}
                  min={-limits.y}
                  onChange={(event) => updateTransform({ ...transform, offsetY: Number(event.currentTarget.value) })}
                  step="1"
                  type="range"
                  value={transform.offsetY}
                />
              </label>
            </div>
            {error && <p className={styles.error} role="alert">{error}</p>}
            <div className={styles.dialogActions}>
              <button className={styles.secondaryButton} disabled={isPreparing} onClick={onCancel} type="button">Cancel</button>
              <button className={styles.primaryButton} disabled={!imageSize || isPreparing} onClick={preparePreview} type="button">
                {isPreparing ? 'Preparing…' : 'Preview crop'}
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
};
