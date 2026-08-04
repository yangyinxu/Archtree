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

test('records a mood card as an explicit suggested search', async () => {
  const user = userEvent.setup();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
    title: 'Home',
    sections: []
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
  renderHome();

  await user.click(await screen.findByRole('link', { name: /Quiet focus/ }));

  expect(readSearchHistory(null)).toEqual(['ambient']);
});
