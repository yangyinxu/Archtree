import { fireEvent, render, screen } from '@testing-library/react';

import { SeekSlider } from './SeekSlider';

beforeEach(() => {
  vi.stubGlobal('PointerEvent', MouseEvent);
});

const setSliderBounds = (slider: HTMLElement) => {
  vi.spyOn(slider, 'getBoundingClientRect').mockReturnValue({
    bottom: 24,
    height: 4,
    left: 0,
    right: 100,
    top: 20,
    width: 100,
    x: 0,
    y: 20,
    toJSON: () => ({})
  });
};

test('previews pointer time without seeking and commits the final position on release', () => {
  const onSeek = vi.fn();
  render(<SeekSlider currentTime={1} duration={100} itemKey="track-1" onSeek={onSeek} />);
  const slider = screen.getByRole('slider', { name: 'Playback position' });
  setSliderBounds(slider);

  fireEvent.pointerDown(slider, {
    button: 2,
    clientX: 90,
    pointerId: 1,
    pointerType: 'mouse'
  });
  fireEvent.pointerUp(slider, {
    button: 2,
    clientX: 90,
    pointerId: 1,
    pointerType: 'mouse'
  });
  expect(onSeek).not.toHaveBeenCalled();

  fireEvent.pointerMove(slider, { clientX: 50, pointerId: 1 });
  expect(screen.getByText('0:50')).toBeInTheDocument();
  expect(slider).toHaveValue('1');
  expect(onSeek).not.toHaveBeenCalled();

  fireEvent.pointerDown(slider, { button: 0, clientX: 20, pointerId: 1 });
  fireEvent.pointerMove(slider, { clientX: 75, pointerId: 1 });
  expect(slider).toHaveValue('75');
  expect(onSeek).not.toHaveBeenCalled();
  fireEvent.pointerUp(slider, { clientX: 75, pointerId: 1 });
  expect(onSeek).toHaveBeenCalledOnce();
  expect(onSeek).toHaveBeenCalledWith(75);
});

test('commits native keyboard range changes and disables unknown durations', () => {
  const onSeek = vi.fn();
  const { rerender } = render(
    <SeekSlider currentTime={10} duration={100} itemKey="track-1" onSeek={onSeek} />
  );
  const slider = screen.getByRole('slider', { name: 'Playback position' });

  fireEvent.change(slider, { target: { value: '35' } });
  expect(onSeek).toHaveBeenCalledWith(35);
  rerender(<SeekSlider currentTime={35} duration={100} itemKey="track-1" onSeek={onSeek} />);
  expect(slider).toHaveAttribute('aria-valuetext', '0:35');

  rerender(<SeekSlider currentTime={0} duration={0} itemKey="track-2" onSeek={onSeek} />);
  expect(slider).toBeDisabled();
  expect(screen.queryByText('0:35')).not.toBeInTheDocument();
});
