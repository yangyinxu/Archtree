import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent
} from 'react';

import { Icon } from '../components/Icon';
import styles from './PanelResizeHandle.module.css';

const KEYBOARD_STEP = 8;
const KEYBOARD_LARGE_STEP = 32;

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(Math.max(value, minimum), maximum);

const formatPanelWidth = (value: number) => {
  const pixels = Math.round(value);
  return `${pixels} ${pixels === 1 ? 'pixel' : 'pixels'} wide`;
};

export type PanelResizeSide = 'left' | 'right';

export interface PanelResizeHandleProps {
  side: PanelResizeSide;
  label: string;
  controls: string;
  value: number;
  min: number;
  max: number;
  onCancel(): void;
  onChange(value: number): void;
  onCommit(value: number): void;
  onDragStart(): void;
}

interface ActiveDrag {
  body: HTMLElement;
  currentValue: number;
  direction: 1 | -1;
  documentElement: HTMLElement;
  pointerId: number;
  previousBodyCursor: string;
  previousBodyUserSelect: string;
  previousDocumentCursor: string;
  previousResizeSide: string | undefined;
  startValue: number;
  startX: number;
  target: HTMLDivElement;
}

/** Provides pointer and keyboard resizing without owning the panel-width state. */
export const PanelResizeHandle = ({
  side,
  label,
  controls,
  value,
  min,
  max,
  onCancel,
  onChange,
  onCommit,
  onDragStart
}: PanelResizeHandleProps) => {
  const minimum = Number.isFinite(min) ? min : 0;
  const maximum = Number.isFinite(max) ? Math.max(max, minimum) : minimum;
  const safeValue = clamp(Number.isFinite(value) ? value : minimum, minimum, maximum);
  const activeDrag = useRef<ActiveDrag | null>(null);
  const bounds = useRef({ minimum, maximum });
  const callbacks = useRef({ onCancel, onChange, onCommit, onDragStart });
  const mounted = useRef(true);
  const [dragValue, setDragValue] = useState<number | null>(null);
  const dragging = dragValue !== null;

  bounds.current = { minimum, maximum };
  callbacks.current = { onCancel, onChange, onCommit, onDragStart };

  const stopDrag = useCallback((outcome: 'cancel' | 'commit' | 'cleanup') => {
    const drag = activeDrag.current;
    if (!drag) return;
    activeDrag.current = null;

    const currentBounds = bounds.current;
    const currentValue = clamp(drag.currentValue, currentBounds.minimum, currentBounds.maximum);
    if (outcome === 'cancel'
      || (outcome === 'commit' && currentValue === drag.startValue)) {
      callbacks.current.onCancel();
    } else if (outcome === 'commit') {
      callbacks.current.onCommit(currentValue);
    } else if (outcome === 'cleanup') {
      callbacks.current.onCancel();
    }

    try {
      if (drag.target.hasPointerCapture?.(drag.pointerId)) {
        drag.target.releasePointerCapture?.(drag.pointerId);
      }
    } catch {
      // Losing the target or capture must not leave global drag styles behind.
    }

    drag.documentElement.style.cursor = drag.previousDocumentCursor;
    drag.body.style.cursor = drag.previousBodyCursor;
    drag.body.style.userSelect = drag.previousBodyUserSelect;
    if (drag.previousResizeSide === undefined) {
      delete drag.body.dataset.panelResizing;
    } else {
      drag.body.dataset.panelResizing = drag.previousResizeSide;
    }

    if (mounted.current) setDragValue(null);
  }, []);

  useEffect(() => {
    if (!dragging) return undefined;
    const ownerWindow = activeDrag.current?.target.ownerDocument.defaultView;
    if (!ownerWindow) return undefined;
    const commitOnBlur = () => stopDrag('commit');
    ownerWindow.addEventListener('blur', commitOnBlur);
    return () => ownerWindow.removeEventListener('blur', commitOnBlur);
  }, [dragging, stopDrag]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stopDrag('cleanup');
    };
  }, [stopDrag]);

  const valueAtPointer = (clientX: number, drag: ActiveDrag) => {
    const currentBounds = bounds.current;
    const delta = (clientX - drag.startX) * drag.direction;
    return clamp(
      Math.round(drag.startValue + delta),
      currentBounds.minimum,
      currentBounds.maximum
    );
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.isPrimary === false || activeDrag.current) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });

    const ownerDocument = event.currentTarget.ownerDocument;
    const { body, documentElement } = ownerDocument;
    callbacks.current.onDragStart();
    activeDrag.current = {
      body,
      currentValue: safeValue,
      direction: side === 'left' ? 1 : -1,
      documentElement,
      pointerId: event.pointerId,
      previousBodyCursor: body.style.cursor,
      previousBodyUserSelect: body.style.userSelect,
      previousDocumentCursor: documentElement.style.cursor,
      previousResizeSide: body.dataset.panelResizing,
      startValue: safeValue,
      startX: event.clientX,
      target: event.currentTarget
    };
    documentElement.style.cursor = 'col-resize';
    body.style.cursor = 'col-resize';
    body.style.userSelect = 'none';
    body.dataset.panelResizing = side;
    setDragValue(safeValue);

    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Local pointer events remain usable if an older browser rejects capture.
    }
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = activeDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    const nextValue = valueAtPointer(event.clientX, drag);
    if (nextValue === drag.currentValue) return;
    drag.currentValue = nextValue;
    setDragValue(nextValue);
    callbacks.current.onChange(nextValue);
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = activeDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    const nextValue = valueAtPointer(event.clientX, drag);
    if (nextValue !== drag.currentValue) callbacks.current.onChange(nextValue);
    drag.currentValue = nextValue;
    stopDrag('commit');
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || activeDrag.current) return;
    const step = event.shiftKey ? KEYBOARD_LARGE_STEP : KEYBOARD_STEP;
    let nextValue: number | null = null;

    if (event.key === 'Home') nextValue = minimum;
    else if (event.key === 'End') nextValue = maximum;
    else if (event.key === 'ArrowLeft') {
      nextValue = safeValue + (side === 'left' ? -step : step);
    } else if (event.key === 'ArrowRight') {
      nextValue = safeValue + (side === 'left' ? step : -step);
    }

    if (nextValue === null) return;
    event.preventDefault();
    nextValue = clamp(nextValue, minimum, maximum);
    if (nextValue === safeValue) return;
    callbacks.current.onChange(nextValue);
    callbacks.current.onCommit(nextValue);
  };

  const visibleValue = clamp(dragValue ?? safeValue, minimum, maximum);

  return (
    <div
      aria-controls={controls}
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemax={maximum}
      aria-valuemin={minimum}
      aria-valuenow={visibleValue}
      aria-valuetext={formatPanelWidth(visibleValue)}
      className={styles.handle}
      data-dragging={dragging || undefined}
      data-side={side}
      onKeyDown={handleKeyDown}
      onLostPointerCapture={(event) => {
        if (activeDrag.current?.pointerId === event.pointerId) stopDrag('commit');
      }}
      onPointerCancel={(event) => {
        if (activeDrag.current?.pointerId === event.pointerId) stopDrag('cancel');
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      role="separator"
      tabIndex={0}
    >
      <span aria-hidden="true" className={styles.indicator}>
        <Icon name="arrow-left" />
        <Icon name="arrow-right" />
      </span>
    </div>
  );
};
