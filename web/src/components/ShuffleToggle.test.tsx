import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { playerStore } from '../player';
import { ShuffleToggle } from './ShuffleToggle';

afterEach(() => {
  vi.restoreAllMocks();
  if (playerStore.getSnapshot().shuffleEnabled) act(() => playerStore.toggleShuffle());
});

test('aria-pressed follows the shared shuffle state', () => {
  render(<ShuffleToggle />);
  const toggle = screen.getByRole('button', { name: 'Shuffle off. Turn shuffle on' });
  expect(toggle).toHaveAttribute('aria-pressed', 'false');

  act(() => playerStore.toggleShuffle());
  expect(screen.getByRole('button', { name: 'Shuffle enabled. Turn shuffle off' }))
    .toHaveAttribute('aria-pressed', 'true');
});

test('a click flips shuffle through the player store, and a disabled toggle does nothing', async () => {
  const user = userEvent.setup();
  const toggleShuffle = vi.spyOn(playerStore, 'toggleShuffle');
  const { rerender } = render(<ShuffleToggle disabled />);
  await user.click(screen.getByRole('button', { name: 'Shuffle off. Turn shuffle on' }));
  expect(toggleShuffle).not.toHaveBeenCalled();

  rerender(<ShuffleToggle />);
  await user.click(screen.getByRole('button', { name: 'Shuffle off. Turn shuffle on' }));
  expect(toggleShuffle).toHaveBeenCalledOnce();
  expect(screen.getByRole('button', { name: 'Shuffle enabled. Turn shuffle off' })).toHaveAttribute('aria-pressed', 'true');
});
