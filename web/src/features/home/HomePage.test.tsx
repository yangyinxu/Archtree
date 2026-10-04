import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

import { browserSessionQueryKey } from '../../api/session';
import { SearchQueryProvider } from '../search/SearchQueryProvider';
import { readSearchHistory } from '../search/searchHistory';
import { HomePage } from './HomePage';

/** Renders Home with deterministic query behavior for its fallback states. */
const renderHome = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(browserSessionQueryKey, null);
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <SearchQueryProvider><HomePage /></SearchQueryProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
};

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

test('centers the retry action when Home cannot load', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
  renderHome();

  const retryButton = await screen.findByRole('button', { name: 'Try again' });

  expect(getComputedStyle(retryButton.parentElement!).justifyContent).toBe('center');
});

test('renders the same Carousel attached twice as two independent sections', async () => {
  const consoleError = vi.spyOn(console, 'error');
  const album = {
    contentType: 'album',
    id: '0123456789abcdef01234567',
    title: 'Lorem Ipsum',
    artworkUrl: '',
    artistNames: ['Dolor Ensemble'],
    releaseDate: null
  };
  const attachment = { title: 'Sit Amet Picks', presentation: 'carousel', items: [album, album] };
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
    title: 'Evening selection',
    // Each attachment of one Carousel carries its own persisted Page item ID.
    sections: [
      { id: '1123456789abcdef01234567', ...attachment },
      { id: '2123456789abcdef01234567', ...attachment }
    ]
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
  const { container } = renderHome();

  const headings = await screen.findAllByRole('heading', { name: 'Sit Amet Picks' });

  expect(headings.map((heading) => heading.id)).toEqual([
    'listener-section-1123456789abcdef01234567',
    'listener-section-2123456789abcdef01234567'
  ]);
  const carousels = container.querySelectorAll('[data-presentation="carousel"]');
  expect(Array.from(carousels, (carousel) => carousel.children.length)).toEqual([2, 2]);
  expect(consoleError.mock.calls.flat().join(' ')).not.toMatch(/same key/);
});

test('records a mood card as an explicit suggested search', async () => {
  const user = userEvent.setup();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
    title: 'Evening selection',
    sections: []
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
  renderHome();

  expect(await screen.findByRole('heading', { name: 'Evening selection' })).toBeInTheDocument();
  expect(screen.queryByText('Leave room for the music.')).not.toBeInTheDocument();
  await user.click(await screen.findByRole('link', { name: /Quiet focus/ }));

  expect(readSearchHistory(null)).toEqual(['ambient']);
});
