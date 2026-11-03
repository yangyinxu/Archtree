import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import VideoPreviewSettings from './VideoPreviewSettings';
import { readVideoPreviewMuted, setVideoPreviewMuted } from './videoPreviewPreferences';

beforeEach(() => { setVideoPreviewMuted(false); localStorage.clear(); });

test('anonymous settings default to sound and persist a muted choice across a fresh mount', async () => {
  const user = userEvent.setup();
  const { unmount } = render(<VideoPreviewSettings />);
  const trigger = screen.getByRole('button', { name: 'Preview settings' });
  await user.click(trigger);
  const checkbox = screen.getByRole('checkbox', { name: 'Mute previews by default' });
  expect(checkbox).not.toBeChecked();
  await waitFor(() => expect(checkbox).toHaveFocus());
  await user.click(checkbox);
  expect(readVideoPreviewMuted()).toBe(true);
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
  unmount();
  render(<VideoPreviewSettings />);
  await user.click(screen.getByRole('button', { name: 'Preview settings' }));
  expect(screen.getByRole('checkbox', { name: 'Mute previews by default' })).toBeChecked();
});

test('an open settings control follows browser storage updates from another tab', async () => {
  render(<VideoPreviewSettings />);
  await userEvent.setup().click(screen.getByRole('button', { name: 'Preview settings' }));
  localStorage.setItem('finitude:video-preview-muted', 'true');
  fireEvent(window, new StorageEvent('storage', { key: 'finitude:video-preview-muted', newValue: 'true' }));
  expect(screen.getByRole('checkbox', { name: 'Mute previews by default' })).toBeChecked();
});
