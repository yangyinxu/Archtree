import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

import { browserSessionQueryKey } from '../../api/session';
import { listenerVideosQueryKey } from '../../api/listenerVideos';
import { VideosPage } from './VideosPage';

vi.mock('./VideoPreviewGrid', () => { throw new TypeError('Failed to fetch dynamically imported module'); });

test('an unavailable immersive view chunk preserves the playable default Grid', async () => {
  window.localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({}), { headers: { 'Content-Type': 'application/json' } })));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(browserSessionQueryKey, null);
  client.setQueryData(listenerVideosQueryKey, { pages: [{ items: [{
    contentType: 'audioTrack', id: 'retained-video', title: 'Retained Video', artworkUrl: '',
    artistNames: [], albumId: null, albumTitle: null, duration: '0:22', mediaType: 'video',
    streamUrl: '/content/mediaTrack/stream/retained-video'
  }], nextCursor: null }], pageParams: [undefined] });
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const { container } = render(<QueryClientProvider client={client}><MemoryRouter><VideosPage /></MemoryRouter></QueryClientProvider>);
  await userEvent.setup().click(screen.getByRole('button', { name: 'Immersive preview' }));
  expect(await screen.findByRole('button', { name: 'Play Retained Video' })).toBeInTheDocument();
  expect(container.querySelector('[data-presentation="grid"]')).toBeInTheDocument();
  expect(container.querySelector('[data-video-frame="portrait"]')).toBeNull();
  expect(errors).not.toHaveBeenCalled();
  window.localStorage.clear();
  errors.mockRestore();
});
