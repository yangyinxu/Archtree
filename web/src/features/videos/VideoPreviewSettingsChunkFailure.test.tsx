import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

import { browserSessionQueryKey } from '../../api/session';
import { VideosPage } from './VideosPage';

vi.mock('./VideoPreviewSettings', () => { throw new TypeError('Failed to fetch dynamically imported module'); });

test('an unavailable optional settings chunk leaves Video browsing usable', async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(browserSessionQueryKey, null);
  localStorage.removeItem('finitude:video-browse-view');
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [], nextCursor: null }), {
    headers: { 'Content-Type': 'application/json' }
  })));
  render(<QueryClientProvider client={client}><MemoryRouter><VideosPage /></MemoryRouter></QueryClientProvider>);

  expect(await screen.findByRole('heading', { name: 'Video', level: 1 })).toBeInTheDocument();
  expect(await screen.findByText('No music is available in this section yet.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Grid' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: 'Immersive preview' })).toBeEnabled();
  expect(screen.queryByRole('button', { name: 'Preview settings' })).not.toBeInTheDocument();
  expect(errors).not.toHaveBeenCalled();
  errors.mockRestore();
});
