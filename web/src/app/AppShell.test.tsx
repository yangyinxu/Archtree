import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  createMemoryRouter,
  MemoryRouter,
  Route,
  RouterProvider,
  Routes,
  useLocation
} from 'react-router';

import { browserSessionQueryKey } from '../api/session';
import { HomePage } from '../features/home/HomePage';
import { LoginPage } from '../features/account/LoginPage';
import { SearchQueryProvider } from '../features/search/SearchQueryProvider';
import { SearchPage } from '../features/search/SearchPage';
import { readSearchHistory } from '../features/search/searchHistory';
import { AppShell } from './AppShell';
import { appRoutes } from './router';

const renderRoute = (path: string) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  });
  queryClient.setQueryData(browserSessionQueryKey, null);
  const router = createMemoryRouter(appRoutes, { initialEntries: [path] });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
  return { queryClient, router, ...view };
};

const renderLoginFlow = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  });
  queryClient.setQueryData(browserSessionQueryKey, null);
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/login']}>
        <SearchQueryProvider>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/login" element={<LoginPage />} />
          </Routes>
        </SearchQueryProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
};

afterEach(() => window.localStorage.clear());

const LocationProbe = () => {
  const location = useLocation();
  return <output data-testid="location-state">{JSON.stringify({
    pathname: location.pathname,
    search: location.search,
    state: location.state
  })}</output>;
};

test('renders responsive navigation and exactly one persistent player surface', async () => {
  const { container } = renderRoute('/');

  expect(await screen.findByRole('heading', { name: 'Leave room for the music.' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Skip to main content' })).toHaveAttribute('href', '#main-content');
  expect(container.querySelectorAll('nav[aria-label="Primary"]')).toHaveLength(2);
  expect(screen.getAllByRole('link', { name: 'Library' })).toHaveLength(1);
  expect(screen.getAllByRole('region', { name: 'Now playing' })).toHaveLength(1);
});

test('shows authentication-required Library instead of an empty success', async () => {
  renderRoute('/library');

  expect(await screen.findByRole('heading', { name: 'Log in to open your Library' })).toBeInTheDocument();
  expect(screen.getAllByRole('link', { name: 'Log in' }).some((link) => link.getAttribute('href') === '/login')).toBe(true);
});

test('announces an unknown nested address as not found', async () => {
  renderRoute('/library/unknown');

  expect(await screen.findByText('Page not found page')).toBeInTheDocument();
  expect(document.title).toBe('Page not found · Finitude');
});

test('logs in through the browser session endpoint and returns Home', async () => {
  const user = userEvent.setup();
  const fetchMock = vi.fn(async (path: string) => new Response(JSON.stringify(
    path === '/auth/browser/capabilities'
      ? {
          password: true,
          emailRegistration: true,
          apple: false,
          google: false,
          passkey: false
        }
      : {
          user: {
            id: 'listener-1',
            email: 'listener@example.com',
            role: 'user',
            displayName: 'Quiet Listener',
            avatarRevision: 0,
            avatar: null,
            emailVerified: true,
            authenticationMethods: ['password']
          }
        }
  ), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  renderLoginFlow();

  await user.type(screen.getByLabelText('Email or username'), 'listener@example.com');
  await user.type(screen.getByLabelText('Password'), 'a private password');
  await user.click(screen.getByRole('button', { name: 'Log in' }));

  await waitFor(() => {
    expect(screen.getByRole('heading', { name: 'Leave room for the music.' })).toBeInTheDocument();
  });
  expect(fetchMock).toHaveBeenCalledWith(
    '/auth/browser/login',
    expect.objectContaining({ credentials: 'same-origin', method: 'POST' })
  );
});

test('keeps the search field synchronized with URL-driven suggestions', async () => {
  const user = userEvent.setup();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(browserSessionQueryKey, null);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
    query: 'Ambient',
    artists: [],
    albums: [],
    audioTracks: []
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/search']}>
        <Routes>
          <Route
            path="/search"
            element={<SearchQueryProvider><SearchPage /></SearchQueryProvider>}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );

  await user.click(screen.getByRole('link', { name: 'Ambient' }));
  expect(screen.getByRole('searchbox', {
    name: 'Search artists, albums, and soundtracks'
  })).toHaveValue('Ambient');
  expect(screen.getByRole('heading', { name: 'Results for “Ambient”' })).toBeInTheDocument();
  expect(readSearchHistory(null)).toEqual(['Ambient']);
});

test('previews a debounced global search but records it only on submission', async () => {
  const user = userEvent.setup();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(browserSessionQueryKey, null);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
    query: 'Piano',
    artists: [],
    albums: [],
    audioTracks: []
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<div>Home</div>} />
            <Route path="/search" element={<SearchPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );

  const globalSearch = screen.getByRole('search', { name: 'Global search' });
  await user.type(within(globalSearch).getByRole('searchbox'), 'Piano');
  expect(readSearchHistory(null)).toEqual([]);

  expect(await screen.findByRole('heading', { name: 'Results for “Piano”' }, {
    timeout: 1_000
  })).toBeInTheDocument();
  expect(readSearchHistory(null)).toEqual([]);

  await user.click(within(globalSearch).getByRole('button', { name: 'Submit search' }));

  expect(readSearchHistory(null)).toEqual(['Piano']);

  await user.clear(within(globalSearch).getByRole('searchbox'));

  expect(await screen.findByRole('heading', { name: 'Recent searches' }, {
    timeout: 1_000
  })).toBeInTheDocument();
  expect(readSearchHistory(null)).toEqual(['Piano']);
});

test('cancels the pending preview timer when global Search is submitted', async () => {
  const user = userEvent.setup();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(browserSessionQueryKey, null);
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
    query: 'Edge',
    artists: [],
    albums: [],
    audioTracks: []
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/']}>
        <LocationProbe />
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<div>Home</div>} />
            <Route path="/search" element={<SearchPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );

  const globalSearch = screen.getByRole('search', { name: 'Global search' });
  fireEvent.change(within(globalSearch).getByRole('searchbox'), {
    target: { value: 'Edge' }
  });
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 250));
  });
  await user.click(within(globalSearch).getByRole('button', { name: 'Submit search' }));

  expect(await screen.findByRole('heading', { name: 'Results for “Edge”' }))
    .toBeInTheDocument();
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 100));
  });
  expect(JSON.parse(screen.getByTestId('location-state').textContent ?? '{}')).toEqual({
    pathname: '/search',
    search: '?q=Edge',
    state: null
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(readSearchHistory(null)).toEqual(['Edge']);
});

test('waits for global Search IME composition before previewing or recording', async () => {
  const user = userEvent.setup();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(browserSessionQueryKey, null);
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
    query: '夜',
    artists: [],
    albums: [],
    audioTracks: []
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<div>Home</div>} />
            <Route path="/search" element={<SearchPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );

  const globalSearch = screen.getByRole('search', { name: 'Global search' });
  const input = within(globalSearch).getByRole('searchbox');
  fireEvent.compositionStart(input);
  fireEvent.change(input, { target: { value: '夜' } });
  fireEvent.keyDown(input, { key: 'Enter', keyCode: 229, isComposing: true });
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 350));
  });

  expect(fetchMock).not.toHaveBeenCalled();
  expect(readSearchHistory(null)).toEqual([]);

  fireEvent.compositionEnd(input, { data: '夜' });
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 350));
  });
  expect(screen.getByRole('heading', { name: 'Results for “夜”' })).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(readSearchHistory(null)).toEqual([]);

  await user.click(input);
  await user.keyboard('{Enter}');
  expect(readSearchHistory(null)).toEqual(['夜']);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
