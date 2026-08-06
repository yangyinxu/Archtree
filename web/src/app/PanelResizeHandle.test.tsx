import { useRef, useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

import {
  PanelResizeHandle,
  type PanelResizeHandleProps
} from './PanelResizeHandle';

class ResizePointerEvent extends MouseEvent {
  readonly isPrimary: boolean;
  readonly pointerId: number;
  readonly pointerType: string;

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.isPrimary = init.isPrimary ?? true;
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? 'mouse';
  }
}

beforeEach(() => {
  vi.stubGlobal('PointerEvent', ResizePointerEvent);
});

afterEach(() => {
  document.documentElement.style.cursor = '';
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
  delete document.body.dataset.panelResizing;
});

const ControlledHandle = ({
  onCancel,
  onChange,
  onDragStart,
  ...props
}: PanelResizeHandleProps) => {
  const [value, setValue] = useState(props.value);
  const valueRef = useRef(value);
  const dragStartValue = useRef(value);
  valueRef.current = value;
  return (
    <PanelResizeHandle
      {...props}
      onCancel={() => {
        setValue(dragStartValue.current);
        onCancel();
      }}
      onChange={(nextValue) => {
        setValue(nextValue);
        onChange(nextValue);
      }}
      onDragStart={() => {
        dragStartValue.current = valueRef.current;
        onDragStart();
      }}
      value={value}
    />
  );
};

const handleProps = (overrides: Partial<PanelResizeHandleProps> = {}): PanelResizeHandleProps => ({
  controls: 'library-panel',
  label: 'Resize Library panel',
  max: 420,
  min: 280,
  onCancel: vi.fn(),
  onChange: vi.fn(),
  onCommit: vi.fn(),
  onDragStart: vi.fn(),
  side: 'left',
  value: 300,
  ...overrides
});

test('exposes a vertical separator with the controlled panel width', () => {
  render(<PanelResizeHandle {...handleProps()} />);

  const handle = screen.getByRole('separator', { name: 'Resize Library panel' });
  expect(handle).toHaveAttribute('aria-controls', 'library-panel');
  expect(handle).toHaveAttribute('aria-orientation', 'vertical');
  expect(handle).toHaveAttribute('aria-valuemin', '280');
  expect(handle).toHaveAttribute('aria-valuemax', '420');
  expect(handle).toHaveAttribute('aria-valuenow', '300');
  expect(handle).toHaveAttribute('aria-valuetext', '300 pixels wide');
  expect(handle).toHaveAttribute('tabindex', '0');
});

test('supports physical arrow directions, accelerated steps, and range boundaries', () => {
  const onChange = vi.fn();
  const onCommit = vi.fn();
  render(<ControlledHandle {...handleProps({ onChange, onCommit })} />);
  const handle = screen.getByRole('separator');

  fireEvent.keyDown(handle, { key: 'ArrowRight' });
  expect(handle).toHaveAttribute('aria-valuenow', '308');
  fireEvent.keyDown(handle, { key: 'ArrowLeft', shiftKey: true });
  expect(handle).toHaveAttribute('aria-valuenow', '280');
  fireEvent.keyDown(handle, { key: 'End' });
  expect(handle).toHaveAttribute('aria-valuenow', '420');
  fireEvent.keyDown(handle, { key: 'Home' });
  expect(handle).toHaveAttribute('aria-valuenow', '280');

  expect(onChange.mock.calls.map(([nextValue]) => nextValue)).toEqual([308, 280, 420, 280]);
  expect(onCommit.mock.calls.map(([nextValue]) => nextValue)).toEqual([308, 280, 420, 280]);
});

test('maps right-panel arrows to the separator moving in the pressed direction', () => {
  const onChange = vi.fn();
  const onCommit = vi.fn();
  render(
    <ControlledHandle
      {...handleProps({
        controls: 'now-playing-panel',
        label: 'Resize Now Playing panel',
        onChange,
        onCommit,
        side: 'right',
        value: 320
      })}
    />
  );
  const handle = screen.getByRole('separator');

  fireEvent.keyDown(handle, { key: 'ArrowLeft' });
  expect(handle).toHaveAttribute('aria-valuenow', '328');
  fireEvent.keyDown(handle, { key: 'ArrowRight', shiftKey: true });
  expect(handle).toHaveAttribute('aria-valuenow', '296');
  expect(onCommit).toHaveBeenLastCalledWith(296);
});

test('inverts pointer movement when resizing the right panel', () => {
  const onChange = vi.fn();
  const onCommit = vi.fn();
  render(
    <ControlledHandle
      {...handleProps({ onChange, onCommit, side: 'right', value: 360 })}
    />
  );
  const handle = screen.getByRole('separator');
  Object.defineProperties(handle, {
    hasPointerCapture: { configurable: true, value: vi.fn(() => false) },
    releasePointerCapture: { configurable: true, value: vi.fn() },
    setPointerCapture: { configurable: true, value: vi.fn() }
  });

  fireEvent.pointerDown(handle, { button: 0, clientX: 100, pointerId: 5 });
  fireEvent.pointerMove(handle, { clientX: 180, pointerId: 5 });
  fireEvent.pointerUp(handle, { clientX: 180, pointerId: 5 });

  expect(onChange).toHaveBeenCalledOnce();
  expect(onChange).toHaveBeenCalledWith(280);
  expect(onCommit).toHaveBeenCalledWith(280);
});

test('captures a pointer, clamps live changes, and commits once on release', () => {
  const onChange = vi.fn();
  const onCommit = vi.fn();
  render(<ControlledHandle {...handleProps({ onChange, onCommit })} />);
  const handle = screen.getByRole('separator');
  const capturePointer = vi.fn();
  const releasePointer = vi.fn();
  Object.defineProperties(handle, {
    hasPointerCapture: { configurable: true, value: vi.fn(() => true) },
    releasePointerCapture: { configurable: true, value: releasePointer },
    setPointerCapture: { configurable: true, value: capturePointer }
  });
  document.documentElement.style.cursor = 'crosshair';
  document.body.style.userSelect = 'text';

  fireEvent.pointerDown(handle, { button: 0, clientX: 100, pointerId: 7 });
  expect(capturePointer).toHaveBeenCalledWith(7);
  expect(handle).toHaveAttribute('data-dragging', 'true');
  expect(document.body.style.userSelect).toBe('none');
  expect(document.body.dataset.panelResizing).toBe('left');

  fireEvent.pointerMove(handle, { clientX: 170, pointerId: 7 });
  expect(handle).toHaveAttribute('aria-valuenow', '370');
  fireEvent.pointerUp(handle, { clientX: 260, pointerId: 7 });

  expect(onChange.mock.calls.map(([nextValue]) => nextValue)).toEqual([370, 420]);
  expect(onCommit).toHaveBeenCalledOnce();
  expect(onCommit).toHaveBeenCalledWith(420);
  expect(releasePointer).toHaveBeenCalledWith(7);
  expect(handle).not.toHaveAttribute('data-dragging');
  expect(document.documentElement.style.cursor).toBe('crosshair');
  expect(document.body.style.userSelect).toBe('text');
  expect(document.body).not.toHaveAttribute('data-panel-resizing');
});

test('does not commit or change a preference for a no-op pointer click', () => {
  const onCancel = vi.fn();
  const onChange = vi.fn();
  const onCommit = vi.fn();
  const onDragStart = vi.fn();
  render(
    <ControlledHandle
      {...handleProps({ onCancel, onChange, onCommit, onDragStart, value: 416 })}
    />
  );
  const handle = screen.getByRole('separator');

  fireEvent.pointerDown(handle, { button: 0, clientX: 100, pointerId: 21 });
  fireEvent.pointerUp(handle, { clientX: 100, pointerId: 21 });

  expect(onDragStart).toHaveBeenCalledOnce();
  expect(onCancel).toHaveBeenCalledOnce();
  expect(onChange).not.toHaveBeenCalled();
  expect(onCommit).not.toHaveBeenCalled();
  expect(handle).toHaveAttribute('aria-valuenow', '416');
});

test('rolls back a cancelled pointer drag and ignores later movement', () => {
  const onCancel = vi.fn();
  const onChange = vi.fn();
  const onCommit = vi.fn();
  render(
    <ControlledHandle {...handleProps({ onCancel, onChange, onCommit, value: 310 })} />
  );
  const handle = screen.getByRole('separator');
  Object.defineProperties(handle, {
    hasPointerCapture: { configurable: true, value: vi.fn(() => true) },
    releasePointerCapture: { configurable: true, value: vi.fn() },
    setPointerCapture: { configurable: true, value: vi.fn() }
  });

  fireEvent.pointerDown(handle, { button: 0, clientX: 100, pointerId: 3 });
  fireEvent.pointerMove(handle, { clientX: 150, pointerId: 3 });
  expect(handle).toHaveAttribute('aria-valuenow', '360');
  fireEvent.pointerCancel(handle, { pointerId: 3 });
  fireEvent.pointerMove(handle, { clientX: 200, pointerId: 3 });

  expect(onChange.mock.calls.map(([nextValue]) => nextValue)).toEqual([360]);
  expect(onCancel).toHaveBeenCalledOnce();
  expect(onCommit).not.toHaveBeenCalled();
  expect(handle).toHaveAttribute('aria-valuenow', '310');
  expect(handle).not.toHaveAttribute('data-dragging');
});

test('accepts a primary touch pointer', () => {
  const onChange = vi.fn();
  const onCommit = vi.fn();
  render(<ControlledHandle {...handleProps({ onChange, onCommit })} />);
  const handle = screen.getByRole('separator');

  fireEvent.pointerDown(handle, {
    button: 0,
    clientX: 100,
    isPrimary: true,
    pointerId: 31,
    pointerType: 'touch'
  });
  fireEvent.pointerMove(handle, {
    clientX: 132,
    isPrimary: true,
    pointerId: 31,
    pointerType: 'touch'
  });
  fireEvent.pointerUp(handle, {
    clientX: 132,
    isPrimary: true,
    pointerId: 31,
    pointerType: 'touch'
  });

  expect(onChange).toHaveBeenCalledWith(332);
  expect(onCommit).toHaveBeenCalledWith(332);
});

test('commits the last valid width when pointer capture is lost', () => {
  const onChange = vi.fn();
  const onCommit = vi.fn();
  render(<ControlledHandle {...handleProps({ onChange, onCommit, value: 320 })} />);
  const handle = screen.getByRole('separator');
  let captured = false;
  Object.defineProperties(handle, {
    hasPointerCapture: { configurable: true, value: vi.fn(() => captured) },
    releasePointerCapture: { configurable: true, value: vi.fn(() => { captured = false; }) },
    setPointerCapture: { configurable: true, value: vi.fn(() => { captured = true; }) }
  });

  fireEvent.pointerDown(handle, { button: 0, clientX: 100, pointerId: 9 });
  fireEvent.pointerMove(handle, { clientX: 140, pointerId: 9 });
  captured = false;
  fireEvent.lostPointerCapture(handle, { pointerId: 9 });

  expect(onChange).toHaveBeenCalledWith(360);
  expect(onCommit).toHaveBeenCalledOnce();
  expect(onCommit).toHaveBeenCalledWith(360);
  expect(handle).not.toHaveAttribute('data-dragging');
});

test('commits and restores document interaction when the window loses focus', () => {
  const onChange = vi.fn();
  const onCommit = vi.fn();
  render(<ControlledHandle {...handleProps({ onChange, onCommit })} />);
  const handle = screen.getByRole('separator');
  Object.defineProperties(handle, {
    hasPointerCapture: { configurable: true, value: vi.fn(() => false) },
    releasePointerCapture: { configurable: true, value: vi.fn() },
    setPointerCapture: { configurable: true, value: vi.fn() }
  });

  fireEvent.pointerDown(handle, { button: 0, clientX: 100, pointerId: 11 });
  fireEvent.pointerMove(handle, { clientX: 120, pointerId: 11 });
  fireEvent(window, new Event('blur'));

  expect(onChange).toHaveBeenCalledWith(320);
  expect(onCommit).toHaveBeenCalledWith(320);
  expect(handle).not.toHaveAttribute('data-dragging');
  expect(document.body.style.userSelect).toBe('');
  expect(document.body).not.toHaveAttribute('data-panel-resizing');
});
