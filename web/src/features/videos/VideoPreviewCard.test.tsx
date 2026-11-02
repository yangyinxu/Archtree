import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { AudioTrackSummary } from '../../api/contentSchemas';
import { VideoPreviewCard } from './VideoPreviewCard';

const controls = vi.hoisted(() => ({ playingId: null as string | null, pause: vi.fn(), toggle: vi.fn(), stop: vi.fn() }));
vi.mock('../../player', () => ({ playerStore: { pause: controls.pause }, usePlayingTrackId: () => controls.playingId }));
vi.mock('./useVideoCardPreview', () => ({ useVideoCardPreview: () => ({
  active: false, intent: 'hover', cardRef: () => undefined, stop: controls.stop, toggle: controls.toggle
}) }));

const item: AudioTrackSummary = {
  contentType: 'audioTrack', id: 'real-video', title: 'A Window onto the River', artworkUrl: '',
  artistNames: ['Legacy Artist'], displayByline: 'Documented Performer', albumId: null,
  albumTitle: 'Along the Way', duration: '0:22', mediaType: 'video', streamUrl: '/content/mediaTrack/stream/real-video'
};

/** Uses the real Save control while keeping playback and preview ownership observable. */
const renderCard = (track = item) => {
  const onPlay = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { onPlay, ...render(<QueryClientProvider client={client}>
    <VideoPreviewCard item={track} onPlay={onPlay} saved={false} />
  </QueryClientProvider>) };
};

beforeEach(() => { controls.playingId = null; vi.clearAllMocks(); });

test('uses real metadata and independent non-nested playback, preview, save and framing controls', async () => {
  const user = userEvent.setup();
  const { container, onPlay } = renderCard();
  expect(screen.getByRole('heading', { name: item.title })).toBeInTheDocument();
  expect(screen.getByText('Documented Performer')).toBeInTheDocument();
  expect(screen.queryByText('Legacy Artist')).not.toBeInTheDocument();
  expect(container.querySelectorAll('button button')).toHaveLength(0);
  expect(container.querySelector('[data-video-frame="portrait"]')).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: `Preview ${item.title}` }));
  expect(controls.toggle).toHaveBeenCalledTimes(1);
  expect(onPlay).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: `Play ${item.title} by Documented Performer` }));
  expect(controls.stop).toHaveBeenCalled();
  expect(onPlay).toHaveBeenCalledWith(item);
});

test('pauses the playing MediaTrack without relaunching it or changing its metadata', async () => {
  controls.playingId = item.id;
  const { onPlay } = renderCard();
  await userEvent.setup().click(screen.getByRole('button', { name: `Pause ${item.title}` }));
  expect(controls.pause).toHaveBeenCalledTimes(1);
  expect(onPlay).not.toHaveBeenCalled();
});

test('frame options change only presentation and restore focus after selection and Escape', async () => {
  const user = userEvent.setup();
  const { container, onPlay } = renderCard();
  const more = screen.getByRole('button', { name: `${item.title} options` });
  await user.click(more);
  const dialog = await screen.findByRole('dialog', { name: `${item.title} options` });
  const slider = within(dialog).getByRole('slider', { name: `Frame position for ${item.title}` });
  slider.focus();
  fireEvent.change(slider, { target: { value: '100' } });
  expect(slider).toHaveValue('100');
  expect(container.querySelector('[data-video-frame]')).toHaveStyle({ '--video-position': '100%' });
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(more).toHaveFocus();

  await user.click(more);
  await user.click(await screen.findByRole('button', { name: 'Show full frame' }));
  expect(container.querySelector('[data-video-frame]')).toHaveStyle({ '--video-fit': 'contain' });
  expect(more).toHaveFocus();
  await user.click(more);
  expect(await screen.findByRole('slider')).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Fill card' }));
  expect(container.querySelector('[data-video-frame]')).toHaveStyle({ '--video-fit': 'cover' });
  expect(onPlay).not.toHaveBeenCalled();
});

test('signed-out Save remains actionable and explains authentication without launching playback', async () => {
  const { onPlay } = renderCard();
  const save = await screen.findByRole('button', { name: 'Save to Library' });
  await userEvent.setup().click(save);
  expect(await screen.findByRole('alert')).toHaveTextContent(/log in/i);
  expect(onPlay).not.toHaveBeenCalled();
});
