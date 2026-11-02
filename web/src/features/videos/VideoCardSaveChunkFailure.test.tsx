import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { VideoCardSave } from './VideoCardSave';

vi.mock('../../components/SaveButton', () => { throw new TypeError('Failed to fetch dynamically imported module'); });

test('Save stays disabled while its chunk loads, then explains chunk failure without dispatching a mutation', async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  const onSavedChange = vi.fn();
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  render(<VideoCardSave compact saved={false} target={{ contentType: 'audioTrack', contentId: 'video-1' }}
    viewerId="viewer-1" onSavedChange={onSavedChange} />);
  expect(screen.getByRole('button', { name: 'Updating…' })).toBeDisabled();

  await userEvent.setup().click(await screen.findByRole('button', { name: 'Save to Library' }));

  expect(await screen.findByRole('alert')).toHaveTextContent('Finitude could not update your Library. Try again.');
  expect(fetchMock).not.toHaveBeenCalled();
  expect(onSavedChange).not.toHaveBeenCalled();
  expect(errors).not.toHaveBeenCalled();
});

test('a failed Save chunk preserves known Saved state and hides the previous account message', async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  const target = { contentType: 'audioTrack' as const, contentId: 'video-2' };
  const view = render(<VideoCardSave compact saved viewerId="first-viewer" target={target} />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Remove from Library' }));
  expect(await screen.findByRole('alert')).toBeInTheDocument();

  view.rerender(<VideoCardSave compact saved={false} viewerId="second-viewer" target={target} />);

  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Save to Library' })).toBeEnabled();
  expect(fetchMock).not.toHaveBeenCalled();
});
