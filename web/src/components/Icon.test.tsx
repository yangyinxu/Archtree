import { render, screen, waitFor } from '@testing-library/react';
import { Icon, type PlaybackIconName } from './Icon';

test('navigation and identity icons retain their eager SVG, dimensions and hidden accessibility contract', () => {
  render(<Icon name="brand" data-testid="brand" className="brand-mark" size={32} style={{ color: 'red' }} />);
  const icon = screen.getByTestId('brand');
  expect(icon.children.length).toBeGreaterThan(0);
  expect(icon).toHaveAttribute('width', '32');
  expect(icon).toHaveAttribute('height', '32');
  expect(icon).toHaveAttribute('aria-hidden', 'true');
  expect(icon).toHaveAttribute('focusable', 'false');
  expect(icon).toHaveClass('brand-mark');
  expect(icon).toHaveStyle({ color: 'rgb(255, 0, 0)' });
});

test('deferred playback glyphs preserve the placeholder box, labels and final SVG properties', async () => {
  const { rerender } = render(<button aria-label="Play"><Icon name="play" data-testid="transport"
    className="transport-mark" size={30} style={{ color: 'blue' }} /></button>);
  const placeholder = screen.getByTestId('transport');
  expect(placeholder.children).toHaveLength(0);
  expect(placeholder).toHaveAttribute('width', '30');
  expect(placeholder).toHaveAttribute('height', '30');
  expect(placeholder).toHaveAttribute('aria-hidden', 'true');
  expect(placeholder).toHaveClass('transport-mark');
  expect(placeholder).toHaveStyle({ color: 'rgb(0, 0, 255)' });
  expect(screen.getByRole('button', { name: 'Play' })).toBeEnabled();
  await waitFor(() => expect(screen.getByTestId('transport').children.length).toBeGreaterThan(0));
  expect(screen.getByTestId('transport')).toHaveAttribute('fill', 'currentColor');
  expect(screen.getByTestId('transport')).toHaveAttribute('stroke-width', '1.9');
  const names: PlaybackIconName[] = ['expand', 'panel-right', 'pause', 'play', 'previous', 'repeat',
    'repeat-one', 'shuffle', 'next', 'volume', 'volume-off'];
  for (const name of names) {
    rerender(<button aria-label={name}><Icon name={name} data-testid="transport" className="transport-mark" size={30} /></button>);
    const icon = screen.getByTestId('transport');
    expect(icon.children.length).toBeGreaterThan(0);
    expect(icon).toHaveAttribute('width', '30');
    expect(icon).toHaveAttribute('height', '30');
    expect(icon).toHaveAttribute('aria-hidden', 'true');
    expect(icon).toHaveAttribute('fill', ['pause', 'play', 'previous', 'next'].includes(name) ? 'currentColor' : 'none');
    expect(screen.getByRole('button', { name })).toBeEnabled();
  }
});
