import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { AudioTrackSummary } from '../../api/contentSchemas';
import { VideoPreviewCard } from './VideoPreviewCard';

vi.mock('../../components/CardVideoPreview', () => { throw new TypeError('Failed to fetch dynamically imported module'); });

const item: AudioTrackSummary = {
  contentType: 'audioTrack', id: 'missing-preview-chunk', title: 'Still a Video', artworkUrl: '/video.jpg',
  artistNames: [], albumId: null, albumTitle: null, duration: '0:22', mediaType: 'video',
  streamUrl: '/content/mediaTrack/stream/missing-preview-chunk'
};

test('a failed preview chunk releases the explicit toggle and preserves real playback and artwork', async () => {
  vi.stubGlobal('fetch', vi.fn());
  const onPlay = vi.fn();
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const { container } = render(<QueryClientProvider client={new QueryClient()}>
    <VideoPreviewCard item={item} onPlay={onPlay} saved={false} />
  </QueryClientProvider>);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Unmute preview for Still a Video' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Unmute preview for Still a Video' })).toHaveAttribute('aria-pressed', 'false'));
  expect(container.querySelector('img')).toHaveAttribute('src', '/video.jpg');
  expect(container.querySelector('video')).toBeNull();
  expect(screen.getByRole('button', { name: 'Play Still a Video' })).toBeEnabled();
  await user.click(screen.getByRole('button', { name: 'Play video: Still a Video' }));
  expect(onPlay).toHaveBeenCalledWith(item);
  expect(fetch).not.toHaveBeenCalled();
  expect(errors).not.toHaveBeenCalled();
  errors.mockRestore();
});
