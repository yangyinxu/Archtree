import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  createMemoryRouter,
  Link,
  MemoryRouter,
  Route,
  RouterProvider,
  Routes,
  useLocation
} from 'react-router';

import { browserSessionQueryKey, browserSessionResolvingQueryKey } from '../api/session';
import { captureAccountOperation } from '../api/accountEpoch';
import { listenerCapabilitiesQueryKey } from '../api/listenerCapabilities';
import { adminWorkspace } from '../features/admin/adminWorkspace';
import { capabilities as adminCapabilities, session as adminSession, viewer } from '../features/admin/adminFixtures.testSupport';
import { HomePage } from '../features/home/HomePage';
import { LoginPage } from '../features/account/LoginPage';
import { SearchQueryProvider } from '../features/search/SearchQueryProvider';
import { SearchPage } from '../features/search/SearchPage';
import { readSearchHistory } from '../features/search/searchHistory';
import { AppShell } from './AppShell';
import { appRoutes } from './router';
import { shellLayoutStorageKey } from './shellLayoutPreferences';
import shellStyles from './AppShell.module.css';
import { playerStore, type PlayerQueueItem } from '../player';

const renderRoute = (path: string, social?: { enabled: boolean; rooms: boolean }) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  });
  queryClient.setQueryData(browserSessionQueryKey, null);
  queryClient.setQueryData(listenerCapabilitiesQueryKey, { playlists: true, ...(social ? { social } : {}) });
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

afterEach(() => { cleanup(); adminWorkspace.reset(); window.localStorage.clear(); });

/** Keeps route/layout tests on a confirmed synthetic administrator without private network requests. */
const renderAdminShell = (path = '/admin/catalog', mode: 'admin' | 'user' = 'admin') => {
  adminWorkspace.reset();
  const guard = captureAccountOperation(viewer);
  adminWorkspace.authorize(guard, true, true);
  adminWorkspace.select(mode);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(browserSessionQueryKey, adminSession);
  queryClient.setQueryData(listenerCapabilitiesQueryKey, { playlists: false });
  queryClient.setQueryData(['admin-capabilities', viewer, guard.epoch], {
    ...adminCapabilities, authority: adminWorkspace.getSnapshot().authority
  });
  return { queryClient, ...render(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={[path]}><Routes>
    <Route element={<AppShell />}><Route path="*" element={<div>Workspace content <Link to="/library">Listener route</Link><Link to="/admin/catalog">Admin route</Link></div>} /></Route>
  </Routes></MemoryRouter></QueryClientProvider>) };
};

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

  expect(await screen.findByRole('heading', { name: 'Made for your moment' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Skip to main content' })).toHaveAttribute('href', '#main-content');
  expect(container.querySelectorAll('nav[aria-label="Primary"]')).toHaveLength(2);
  expect(screen.getAllByRole('link', { name: 'Library' })).toHaveLength(1);
  expect(screen.queryByText('Your Library', { exact: true })).not.toBeInTheDocument();
  expect(await screen.findAllByRole('region', { name: 'Now playing' })).toHaveLength(1);
});

test('moves keyboard focus to main content from the skip link', async () => {
  const user = userEvent.setup();
  renderRoute('/');

  await user.click(screen.getByRole('link', { name: 'Skip to main content' }));

  await waitFor(() => expect(screen.getByRole('main')).toHaveFocus());
});

test('toggles the read-only Now Playing pane without remounting the player', async () => {
  const user = userEvent.setup();
  renderRoute('/');

  const aside = await screen.findByRole('complementary', { name: 'Now Playing details' });
  const player = await screen.findByRole('region', { name: 'Now playing' });
  const hideButton = screen.getByRole('button', { name: 'Hide Now Playing view' });

  expect(aside).not.toHaveAttribute('hidden');
  expect(hideButton).toHaveAttribute('aria-controls', 'now-playing-aside');
  expect(hideButton).toHaveAttribute('aria-expanded', 'true');

  await user.click(hideButton);

  expect(aside).toHaveAttribute('aria-hidden', 'true');
  expect(aside).toHaveAttribute('inert');
  expect(screen.getByRole('button', { name: 'Show Now Playing view' }))
    .toHaveAttribute('aria-expanded', 'false');
  expect(screen.getByRole('region', { name: 'Now playing' })).toBe(player);

  await user.click(screen.getByRole('button', { name: 'Show Now Playing view' }));

  expect(aside).not.toHaveAttribute('aria-hidden');
  expect(aside).not.toHaveAttribute('inert');
  expect(screen.getByRole('region', { name: 'Now playing' })).toBe(player);
});

test.each(['admin', 'user'] as const)('uses a standalone workspace on Admin addresses in %s view', async mode => {
  const { container } = renderAdminShell('/admin/catalog', mode);
  await screen.findByRole('button', { name: 'Current view: ' + (mode === 'admin' ? 'Admin' : 'User') });
  expect(container.querySelector('.' + shellStyles.adminShell)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Finitude home' })).toHaveAttribute('href', '/');
  expect(screen.getByRole('button', { name: 'Change language. Current language: English (United States)' })).toBeVisible();
  expect(screen.getByRole('main')).not.toHaveAttribute('inert');
  expect(screen.getByRole('main')).not.toHaveAttribute('aria-hidden');
  expect(screen.queryByRole('search', { name: 'Global search' })).not.toBeInTheDocument();
  expect(screen.queryByRole('navigation', { name: 'Primary' })).not.toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'Now playing' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Now Playing view/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('separator')).not.toBeInTheDocument();
  for (const id of ['library-sidebar', 'now-playing-aside']) {
    expect(container.querySelector('#' + id)).toHaveAttribute('hidden');
    expect(container.querySelector('#' + id)).toHaveAttribute('inert');
  }
});

test('a direct signed-out Admin address uses the standalone shell while retaining the private gate', async () => {
  const { container } = renderRoute('/admin/imports');
  await screen.findByRole('heading', { name: 'Workbench' });
  expect(screen.getByRole('link', { name: 'Finitude home' })).toHaveAttribute('href', '/');
  expect(screen.getByText('Switch to Admin view to open the workbench. Current administrator access is required.')).toBeInTheDocument();
  expect(container.querySelector('.' + shellStyles.adminShell)).toBeInTheDocument();
  expect(screen.queryByRole('search')).not.toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'Now playing' })).not.toBeInTheDocument();
  expect(container.querySelector('#library-sidebar')).not.toHaveTextContent('New Playlist');
});

test.each(['/library', '/administrator'])('keeps the music shell on the listener address %s', async path => {
  const { container } = renderAdminShell(path);
  await screen.findByRole('region', { name: 'Now playing' });
  expect(container.querySelector('.' + shellStyles.adminShell)).toBeNull();
  expect(screen.getByRole('search', { name: 'Global search' })).toBeVisible();
  expect(container.querySelector('#now-playing-aside')).not.toHaveAttribute('hidden');
  expect(screen.getByRole('button', { name: 'Hide Now Playing view' })).toHaveAttribute('aria-expanded', 'true');
});

test('the management layout remains independent during authority suspension and identity reconciliation', async () => {
  const { container, queryClient } = renderAdminShell();
  await screen.findByRole('button', { name: 'Current view: Admin' });
  act(() => adminWorkspace.suspend());
  expect(container.querySelector('.' + shellStyles.adminShell)).toBeInTheDocument();
  act(() => queryClient.setQueryData(browserSessionResolvingQueryKey, true));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Current view: Admin' })).not.toBeInTheDocument());
  expect(screen.queryByRole('region', { name: 'Now playing' })).not.toBeInTheDocument();
  expect(screen.getByRole('main')).not.toHaveAttribute('inert');
});

test('round trips through management preserve the player queue, position and listener panel choice', async () => {
  const user = userEvent.setup();
  const item: PlayerQueueItem = { id: 'synthetic-track', title: 'Synthetic track', artworkUrl: '', artistNames: ['Synthetic artist'], mediaType: 'audio', streamUrl: '' };
  const snapshot = { ...playerStore.getSnapshot(), queue: [item], currentIndex: 0, currentItem: item, status: 'paused' as const, currentTime: 42, duration: 180 };
  vi.spyOn(playerStore, 'getSnapshot').mockReturnValue(snapshot);
  const pause = vi.spyOn(playerStore, 'pause');
  const preference = JSON.stringify({ version: 1, sidebarWidth: 350, nowPlayingWidth: 360 });
  window.localStorage.setItem(shellLayoutStorageKey, preference);
  const { container } = renderAdminShell('/library');
  await screen.findByRole('region', { name: 'Now playing' });
  await user.click(screen.getByRole('button', { name: 'Hide Now Playing view' }));
  await user.click(screen.getByRole('link', { name: 'Admin route' }));
  expect(screen.queryByRole('region', { name: 'Now playing' })).not.toBeInTheDocument();
  for (const key of [' ', 'ArrowLeft', 'ArrowRight']) fireEvent.keyDown(document, { key });
  expect(playerStore.getSnapshot()).toBe(snapshot);
  expect(pause).not.toHaveBeenCalled();
  await user.click(screen.getByRole('link', { name: 'Listener route' }));
  expect(await screen.findByRole('region', { name: 'Now playing' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Show Now Playing view' })).toHaveAttribute('aria-expanded', 'false');
  expect(container.querySelector('#now-playing-aside')).not.toHaveAttribute('hidden');
  expect(playerStore.getSnapshot()).toBe(snapshot);
  expect(window.localStorage.getItem(shellLayoutStorageKey)).toBe(preference);
});

test('ongoing Video retains its mounted surface without obscuring management content', async () => {
  const user = userEvent.setup();
  const item: PlayerQueueItem = { id: 'synthetic-video', title: 'Synthetic video', artworkUrl: '', artistNames: ['Synthetic artist'], mediaType: 'video', streamUrl: '' };
  const snapshot = { ...playerStore.getSnapshot(), queue: [item], currentIndex: 0, currentItem: item, status: 'paused' as const, currentTime: 42 };
  vi.spyOn(playerStore, 'getSnapshot').mockReturnValue(snapshot);
  const { container } = renderAdminShell('/library');
  await waitFor(() => expect(container.querySelector('[aria-labelledby="video-theater-title"]')).toBeInTheDocument());
  const surface = container.querySelector('[aria-labelledby="video-theater-title"]');
  // Programmatic route changes represent navigation outside the temporarily obscured listener main.
  fireEvent.click(screen.getByRole('link', { name: 'Admin route', hidden: true }));
  expect(screen.getByRole('main')).not.toHaveAttribute('inert');
  expect(screen.getByRole('main')).not.toHaveAttribute('aria-hidden');
  expect(container.querySelector('[data-video-playing]')).toBeNull();
  expect(surface?.parentElement).toHaveAttribute('hidden');
  expect(screen.queryByRole('heading', { name: 'Synthetic video' })).not.toBeInTheDocument();
  expect(playerStore.getSnapshot()).toBe(snapshot);
  await user.click(screen.getByRole('link', { name: 'Listener route' }));
  expect(within(surface as HTMLElement).getByRole('heading', { name: 'Synthetic video' })).toBe(surface?.querySelector('h1'));
  expect(surface?.parentElement).not.toHaveAttribute('hidden');
});

test('resizes and restores wide panels without remounting the player', async () => {
  const user = userEvent.setup();
  const originalWidth = window.innerWidth;
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1_728 });

  try {
    const firstView = renderRoute('/');
    const player = await screen.findByRole('region', { name: 'Now playing' });
    const sidebarHandle = await screen.findByRole('separator', { name: 'Resize Library panel' });
    const nowPlayingHandle = await screen.findByRole('separator', {
      name: 'Resize Now Playing panel'
    });

    expect(sidebarHandle).toHaveAttribute('aria-valuenow', '303');
    expect(sidebarHandle).toHaveAttribute('aria-valuemax', '420');
    expect(nowPlayingHandle).toHaveAttribute('aria-valuenow', '303');

    fireEvent.keyDown(sidebarHandle, { key: 'End' });
    fireEvent.keyDown(nowPlayingHandle, { key: 'End' });

    await waitFor(() => {
      expect(screen.getByRole('separator', { name: 'Resize Library panel' }))
        .toHaveAttribute('aria-valuenow', '420');
      expect(screen.getByRole('separator', { name: 'Resize Now Playing panel' }))
        .toHaveAttribute('aria-valuenow', '420');
    });
    expect(JSON.parse(window.localStorage.getItem(shellLayoutStorageKey) ?? '{}')).toEqual({
      version: 1,
      sidebarWidth: 420,
      nowPlayingWidth: 420
    });
    expect(screen.getByRole('region', { name: 'Now playing' })).toBe(player);

    await user.click(screen.getByRole('button', { name: 'Hide Now Playing view' }));
    expect(screen.queryByRole('separator', { name: 'Resize Now Playing panel' }))
      .not.toBeInTheDocument();
    expect(screen.getByRole('separator', { name: 'Resize Library panel' }))
      .toHaveAttribute('aria-valuenow', '420');
    expect(screen.getByRole('region', { name: 'Now playing' })).toBe(player);

    await user.click(screen.getByRole('button', { name: 'Show Now Playing view' }));
    expect(screen.getByRole('separator', { name: 'Resize Now Playing panel' }))
      .toHaveAttribute('aria-valuenow', '420');
    expect(screen.getByRole('region', { name: 'Now playing' })).toBe(player);

    firstView.unmount();
    renderRoute('/');
    expect(await screen.findByRole('separator', { name: 'Resize Library panel' }))
      .toHaveAttribute('aria-valuenow', '420');
    expect(screen.getByRole('separator', { name: 'Resize Now Playing panel' }))
      .toHaveAttribute('aria-valuenow', '420');
  } finally {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth });
    fireEvent(window, new Event('resize'));
  }
});

test('removes panel separators when the compact shell takes control', async () => {
  const originalWidth = window.innerWidth;
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1_280 });

  try {
    renderRoute('/');
    expect(await screen.findByRole('separator', { name: 'Resize Library panel' }))
      .toBeInTheDocument();

    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1_007 });
    fireEvent(window, new Event('resize'));

    await waitFor(() => {
      expect(screen.queryByRole('separator', { name: 'Resize Library panel' }))
        .not.toBeInTheDocument();
      expect(screen.queryByRole('separator', { name: 'Resize Now Playing panel' }))
        .not.toBeInTheDocument();
    });
  } finally {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth });
    fireEvent(window, new Event('resize'));
  }
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

test('advertises Together only while the social rollout is enabled', async () => {
  const { queryClient } = renderRoute('/', { enabled: false, rooms: false });
  expect(await screen.findByRole('heading', { name: 'Made for your moment' })).toBeInTheDocument();
  expect(screen.getAllByRole('link', { name: 'Library' })).toHaveLength(1);
  expect(screen.queryByRole('link', { name: 'Together' })).not.toBeInTheDocument();
  expect(document.querySelectorAll('a[href="/social"]')).toHaveLength(0);

  act(() => { queryClient.setQueryData(listenerCapabilitiesQueryKey, { playlists: true, social: { enabled: true, rooms: false } }); });
  // Both the wide and compact navigation offer the destination once rollout enables social.
  await waitFor(() => expect(document.querySelectorAll('nav[aria-label="Primary"] a[href="/social"]')).toHaveLength(2));

  act(() => { queryClient.setQueryData(listenerCapabilitiesQueryKey, { playlists: true, social: { enabled: false, rooms: false } }); });
  await waitFor(() => expect(document.querySelectorAll('a[href="/social"]')).toHaveLength(0));
});

test('an older server without rollout state keeps social entry points hidden', async () => {
  renderRoute('/');
  expect(await screen.findByRole('heading', { name: 'Made for your moment' })).toBeInTheDocument();
  expect(document.querySelectorAll('a[href="/social"]')).toHaveLength(0);
});

test('announces the Social route with its product title', async () => {
  renderRoute('/social');
  expect(await screen.findByText('Listen together page')).toBeInTheDocument();
  expect(document.title).toBe('Listen together · Finitude');
});

test.each(['/register', '/register/complete', '/verify-email', '/forgot-password', '/reset-password'])(
  'leaves the Kashewt account page %s out of the app router',
  async (pathname) => {
    // The server redirects these addresses to /account/*, so the app never routes them itself.
    renderRoute(pathname);
    expect(await screen.findByText('Page not found page')).toBeInTheDocument();
    expect(document.title).toBe('Page not found · Finitude');
  }
);

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
    expect(screen.getByRole('heading', { name: 'Made for your moment' })).toBeInTheDocument();
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
    name: 'Search artists, organizations, albums, and MediaTracks'
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

test('expands the compact global Search before submitting it', async () => {
  const user = userEvent.setup();
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(browserSessionQueryKey, null);
  queryClient.setQueryData(listenerCapabilitiesQueryKey, { playlists: true });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<div>Home</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );

  const globalSearch = screen.getByRole('search', { name: 'Global search' });
  const searchbox = within(globalSearch).getByRole('searchbox');
  await user.click(within(globalSearch).getByRole('button', { name: 'Submit search' }));

  expect(searchbox).toHaveFocus();
});

test('cancels the pending preview timer when global Search is submitted', async () => {
  const user = userEvent.setup();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(browserSessionQueryKey, null);
  queryClient.setQueryData(listenerCapabilitiesQueryKey, { playlists: true });
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
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  expect(readSearchHistory(null)).toEqual(['Edge']);
});

test('waits for global Search IME composition before previewing or recording', async () => {
  const user = userEvent.setup();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(browserSessionQueryKey, null);
  queryClient.setQueryData(listenerCapabilitiesQueryKey, { playlists: true });
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
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  expect(readSearchHistory(null)).toEqual([]);

  await user.click(input);
  await user.keyboard('{Enter}');
  expect(readSearchHistory(null)).toEqual(['夜']);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
