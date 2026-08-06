import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';

import { browserSessionQueryKey } from '../../api/session';
import { listenerCapabilitiesQueryKey } from '../../api/listenerCapabilities';
import { playerStore } from '../../player';
import { PlaylistDetailPage } from './PlaylistDetailPage';
import { PlaylistFeatureGate } from './PlaylistFeatureGate';
import { PlaylistIndexPage } from './PlaylistIndexPage';

const session = {
  user: {
    id: 'viewer-1',
    email: 'listener@example.com',
    role: 'user',
    displayName: 'Listener',
    avatarRevision: 0,
    avatar: null,
    emailVerified: true
  }
};

const firstTrack = {
  contentType: 'audioTrack',
  id: 'track-1',
  title: 'Night',
  artworkUrl: '/content/images/64b000000000000000000001',
  artistNames: ['Finite Ensemble'],
  albumId: null,
  albumTitle: null,
  duration: '3:00',
  streamUrl: '/content/audioTrack/stream/track-1'
} as const;

const secondTrack = {
  ...firstTrack,
  id: 'track-2',
  title: 'Dawn',
  streamUrl: '/content/audioTrack/stream/track-2'
} as const;

const detail = {
  id: 'playlist-1',
  name: 'Quiet sequence',
  itemCount: 2,
  artworkUrl: firstTrack.artworkUrl,
  revision: 3,
  createdAt: '2026-08-04T12:00:00.000Z',
  updatedAt: '2026-08-04T12:05:00.000Z',
  items: [
    {
      itemId: 'item-1',
      audioTrackId: firstTrack.id,
      addedAt: '2026-08-04T12:01:00.000Z',
      availability: 'ready',
      audioTrack: firstTrack
    },
    {
      itemId: 'item-2',
      audioTrackId: secondTrack.id,
      addedAt: '2026-08-04T12:02:00.000Z',
      availability: 'ready',
      audioTrack: secondTrack
    }
  ]
};

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'Content-Type': 'application/json',
    'X-Finitude-Account-Viewer': 'viewer-1'
  }
});

const renderPage = (
  path: string,
  routePath: string,
  element: ReactNode,
  sessionState: typeof session | null | undefined
) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (sessionState !== undefined) queryClient.setQueryData(browserSessionQueryKey, sessionState);
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes><Route element={element} path={routePath} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
};

const renderPlaylistRoutes = (
  path: string,
  indexElement: ReactNode = <PlaylistIndexPage />,
  detailElement: ReactNode = <PlaylistDetailPage />
) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(browserSessionQueryKey, session);
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <main id="main-content" tabIndex={-1}>
          <Routes>
            <Route element={indexElement} path="/playlists" />
            <Route element={detailElement} path="/playlists/:playlistId" />
          </Routes>
        </main>
      </MemoryRouter>
    </QueryClientProvider>
  );
};

test('session-pending Playlist index renders without starting an unscoped read', () => {
  const fetchMock = vi.fn(() => new Promise<Response>(() => undefined));
  vi.stubGlobal('fetch', fetchMock);

  renderPage('/playlists', '/playlists', <PlaylistIndexPage />, undefined);

  expect(screen.getByText('Checking your account…')).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledWith('/auth/browser/session', expect.any(Object));
});

test('signed-out Playlist index keeps Create visible and explains sign-in without redirecting', async () => {
  const user = userEvent.setup();
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  renderPage('/playlists', '/playlists', <PlaylistIndexPage />, null);

  expect(screen.getByRole('heading', { name: 'Log in to open your Playlists' })).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'New Playlist' }));

  expect(screen.getByRole('dialog', { name: 'Log in to create a Playlist' })).toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalled();
});

test('renders Playlist summaries as dense media rows with complete metadata', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
    items: [{
      id: detail.id,
      name: detail.name,
      itemCount: detail.itemCount,
      artworkUrl: detail.artworkUrl,
      revision: detail.revision,
      createdAt: detail.createdAt,
      updatedAt: detail.updatedAt
    }],
    nextCursor: null
  })));
  renderPage('/playlists', '/playlists', <PlaylistIndexPage />, session);

  const summaryLink = await screen.findByRole('link', {
    name: 'Quiet sequence, 2 soundtracks'
  });
  expect(within(summaryLink).getByText('Playlist · 2 soundtracks')).toBeInTheDocument();
  expect(summaryLink.querySelector('img')).toHaveAttribute('src', detail.artworkUrl);
});

test('a disabled rollout hides private Playlist controls without starting a Playlist read', () => {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(listenerCapabilitiesQueryKey, { playlists: false });
  queryClient.setQueryData(browserSessionQueryKey, session);
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <PlaylistFeatureGate><PlaylistIndexPage /></PlaylistFeatureGate>
      </MemoryRouter>
    </QueryClientProvider>
  );

  expect(screen.getByRole('heading', { name: 'Playlists are not available yet' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'New Playlist' })).not.toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalled();
});

test('creates a trimmed Playlist and navigates to its stable detail route', async () => {
  const user = userEvent.setup();
  const created = {
    id: 'playlist-new',
    name: 'Road notes',
    itemCount: 0,
    artworkUrl: '',
    revision: 1,
    createdAt: '2026-08-04T13:00:00.000Z',
    updatedAt: '2026-08-04T13:00:00.000Z',
    items: []
  };
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => (
    init?.method === 'POST'
      ? jsonResponse(created)
      : jsonResponse({ items: [], nextCursor: null })
  ));
  vi.stubGlobal('fetch', fetchMock);
  renderPlaylistRoutes('/playlists', <PlaylistIndexPage />, <h1>Created Playlist route</h1>);

  expect(await screen.findByRole('heading', { name: 'Make room for a new sequence' })).toBeInTheDocument();
  await user.click(screen.getAllByRole('button', { name: 'New Playlist' })[0]);
  const input = screen.getByRole('textbox', { name: 'Name' });
  expect(input).toHaveFocus();
  await user.type(input, '  Road notes  ');
  await user.click(screen.getByRole('button', { name: 'Create Playlist' }));

  expect(await screen.findByRole('heading', { name: 'Created Playlist route' })).toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole('main')).toHaveFocus());
  const postCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
  expect(JSON.parse(String(postCall?.[1]?.body))).toEqual({ name: 'Road notes' });
  expect(new Headers(postCall?.[1]?.headers).has('If-Match')).toBe(false);
});

test('a pending Playlist dialog keeps focus inside its modal boundary', async () => {
  const user = userEvent.setup();
  let finishCreate!: (response: Response) => void;
  const pendingCreate = new Promise<Response>((resolve) => { finishCreate = resolve; });
  const created = {
    id: 'playlist-pending',
    name: 'Pending focus',
    itemCount: 0,
    artworkUrl: '',
    revision: 1,
    createdAt: '2026-08-04T13:00:00.000Z',
    updatedAt: '2026-08-04T13:00:00.000Z',
    items: []
  };
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => (
    init?.method === 'POST'
      ? pendingCreate
      : jsonResponse({ items: [], nextCursor: null })
  )));
  renderPlaylistRoutes('/playlists', <PlaylistIndexPage />, <h1>Created pending Playlist</h1>);

  await user.click((await screen.findAllByRole('button', { name: 'New Playlist' }))[0]);
  const dialog = screen.getByRole('dialog', { name: 'Create a Playlist' });
  await user.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'Pending focus');
  await user.click(within(dialog).getByRole('button', { name: 'Create Playlist' }));

  await waitFor(() => expect(dialog).toHaveFocus());
  finishCreate(jsonResponse(created));
  expect(await screen.findByRole('heading', { name: 'Created pending Playlist' })).toBeInTheDocument();
});

test('keeps the create dialog open with a clear 100-Playlist quota state', async () => {
  const user = userEvent.setup();
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => (
    init?.method === 'POST'
      ? jsonResponse({
          code: 'playlist_limit_reached',
          message: 'Playlist limit reached.'
        }, 409)
      : jsonResponse({ items: [], nextCursor: null })
  )));
  renderPlaylistRoutes('/playlists');

  expect(await screen.findByRole('heading', { name: 'Make room for a new sequence' })).toBeInTheDocument();
  await user.click(screen.getAllByRole('button', { name: 'New Playlist' })[0]);
  await user.type(screen.getByRole('textbox', { name: 'Name' }), 'One too many');
  await user.click(screen.getByRole('button', { name: 'Create Playlist' }));

  expect(await screen.findByRole('alert')).toHaveTextContent('already have 100 Playlists');
  expect(screen.getByRole('dialog', { name: 'Create a Playlist' })).toBeInTheDocument();
});

test('owner-safe 404 renders an intentional not-found state', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
    code: 'playlist_not_found',
    message: 'Playlist not found.'
  }, 404)));
  renderPage('/playlists/private-id', '/playlists/:playlistId', <PlaylistDetailPage />, session);

  expect(await screen.findByRole('heading', { name: 'Playlist not found' })).toBeInTheDocument();
  expect(screen.getByText(/belongs to another listener/)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Back to Playlists' })).toHaveAttribute('href', '/playlists');
});

test('409 reorder rolls back the optimistic order and announces recovery', async () => {
  const user = userEvent.setup();
  let detailReads = 0;
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      return jsonResponse({
        code: 'playlist_revision_conflict',
        message: 'Playlist changed.',
        currentRevision: 4
      }, 409);
    }
    detailReads += 1;
    return jsonResponse(detail);
  });
  vi.stubGlobal('fetch', fetchMock);
  const { container } = renderPage(
    '/playlists/playlist-1',
    '/playlists/:playlistId',
    <PlaylistDetailPage />,
    session
  );

  expect(await screen.findByRole('heading', { name: 'Quiet sequence' })).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Actions for Dawn' }));
  await user.click(screen.getByRole('menuitem', { name: 'Move Up' }));

  expect(await screen.findByRole('alert')).toHaveTextContent('changed on another device');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Actions for Dawn' })).toHaveFocus());
  await waitFor(() => expect(screen.getByText('Move was not saved.')).toBeInTheDocument());
  await waitFor(() => {
    const rows = Array.from(container.querySelectorAll('ol li'));
    expect(within(rows[0] as HTMLElement).getByText('Night')).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText('Dawn')).toBeInTheDocument();
  });
  expect(detailReads).toBeGreaterThanOrEqual(2);
});

test('renames then deletes with the latest confirmed revision and Cancel-first focus', async () => {
  const user = userEvent.setup();
  const renamed = { ...detail, name: 'Morning sequence', revision: 4 };
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'PATCH') return jsonResponse(renamed);
    if (init?.method === 'DELETE') return new Response(null, {
      status: 204,
      headers: { 'X-Finitude-Account-Viewer': 'viewer-1' }
    });
    return jsonResponse(detail);
  });
  vi.stubGlobal('fetch', fetchMock);
  renderPlaylistRoutes('/playlists/playlist-1', <h1>Playlist index after delete</h1>);

  expect(await screen.findByRole('heading', { name: 'Quiet sequence' })).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Rename' }));
  const nameInput = await screen.findByRole('textbox', { name: 'Name' });
  await waitFor(() => expect(nameInput).toHaveFocus());
  await user.clear(nameInput);
  await user.type(nameInput, 'Morning sequence');
  await user.click(screen.getByRole('button', { name: 'Save name' }));
  expect(await screen.findByRole('heading', { name: 'Morning sequence' })).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'More actions for Morning sequence' }));
  await user.click(screen.getByRole('menuitem', { name: 'Delete Playlist' }));
  const cancel = await screen.findByRole('button', { name: 'Cancel' });
  await waitFor(() => expect(cancel).toHaveFocus());
  await user.click(screen.getByRole('button', { name: 'Delete Playlist' }));

  expect(await screen.findByRole('heading', { name: 'Playlist index after delete' })).toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole('main')).toHaveFocus());
  const deleteCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'DELETE');
  expect(new Headers(deleteCall?.[1]?.headers).get('If-Match')).toBe('"4"');
});

test('removes a member optimistically and commits the server-confirmed detail', async () => {
  const user = userEvent.setup();
  const afterRemoval = {
    ...detail,
    itemCount: 1,
    revision: 4,
    updatedAt: '2026-08-04T12:06:00.000Z',
    items: [detail.items[1]]
  };
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => (
    init?.method === 'DELETE' ? jsonResponse(afterRemoval) : jsonResponse(detail)
  ));
  vi.stubGlobal('fetch', fetchMock);
  renderPlaylistRoutes('/playlists/playlist-1');

  expect(await screen.findByRole('heading', { name: 'Quiet sequence' })).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Actions for Night' }));
  await user.click(screen.getByRole('menuitem', { name: 'Remove from Playlist' }));

  expect(await screen.findByRole('status')).toHaveTextContent('Soundtrack removed');
  expect(screen.queryByRole('button', { name: 'Play Night' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Play Dawn' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Actions for Dawn' })).toHaveFocus();
});

test('removing the last member focuses the previous row action', async () => {
  const user = userEvent.setup();
  const afterRemoval = {
    ...detail,
    itemCount: 1,
    revision: 4,
    updatedAt: '2026-08-04T12:06:00.000Z',
    items: [detail.items[0]]
  };
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => (
    init?.method === 'DELETE' ? jsonResponse(afterRemoval) : jsonResponse(detail)
  )));
  renderPlaylistRoutes('/playlists/playlist-1');

  expect(await screen.findByRole('heading', { name: 'Quiet sequence' })).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Actions for Dawn' }));
  await user.click(screen.getByRole('menuitem', { name: 'Remove from Playlist' }));

  expect(await screen.findByRole('status')).toHaveTextContent('Soundtrack removed');
  expect(screen.getByRole('button', { name: 'Actions for Night' })).toHaveFocus();
});

test('removing the only member focuses the Soundtracks heading', async () => {
  const user = userEvent.setup();
  const single = {
    ...detail,
    itemCount: 1,
    items: [detail.items[0]]
  };
  const empty = {
    ...single,
    itemCount: 0,
    revision: 4,
    updatedAt: '2026-08-04T12:06:00.000Z',
    items: []
  };
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => (
    init?.method === 'DELETE' ? jsonResponse(empty) : jsonResponse(single)
  )));
  renderPlaylistRoutes('/playlists/playlist-1');

  expect(await screen.findByRole('heading', { name: 'Quiet sequence' })).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Actions for Night' }));
  await user.click(screen.getByRole('menuitem', { name: 'Remove from Playlist' }));

  expect(await screen.findByRole('status')).toHaveTextContent('Soundtrack removed');
  expect(screen.getByRole('heading', { name: 'Soundtracks' })).toHaveFocus();
});

test('searches ready Soundtracks and adds the selected result to an empty Playlist', async () => {
  const user = userEvent.setup();
  const empty = {
    ...detail,
    itemCount: 0,
    revision: 1,
    items: []
  };
  const withTrack = {
    ...empty,
    itemCount: 1,
    revision: 2,
    updatedAt: '2026-08-04T12:07:00.000Z',
    items: [detail.items[0]]
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') return jsonResponse(withTrack);
    if (String(input).startsWith('/api/listener/v1/search?')) {
      return jsonResponse({ query: 'Night', artists: [], albums: [], audioTracks: [firstTrack] });
    }
    return jsonResponse(empty);
  });
  vi.stubGlobal('fetch', fetchMock);
  renderPlaylistRoutes('/playlists/playlist-1');

  expect(await screen.findByRole('heading', { name: 'This Playlist is empty' })).toBeInTheDocument();
  await user.click(screen.getAllByRole('button', { name: 'Add Soundtracks' })[0]);
  const dialog = await screen.findByRole('dialog', { name: 'Add Soundtracks' });
  await user.type(within(dialog).getByRole('searchbox', { name: 'Search ready Soundtracks' }), 'Night');
  await user.click(within(dialog).getByRole('button', { name: 'Search' }));
  await user.click(await within(dialog).findByRole('button', { name: 'Add Night to Quiet sequence' }));

  expect(await within(dialog).findByText('Night added.')).toBeInTheDocument();
  await user.click(within(dialog).getByRole('button', { name: 'Done' }));
  expect(screen.getByRole('button', { name: 'Play Night' })).toBeInTheDocument();
});

test('skips unavailable members when snapshotting the persisted Playlist order', async () => {
  const user = userEvent.setup();
  const unavailable = {
    itemId: 'item-unavailable',
    audioTrackId: 'track-unavailable',
    addedAt: '2026-08-04T12:01:30.000Z',
    availability: 'unavailable',
    audioTrack: null
  };
  const mixed = {
    ...detail,
    itemCount: 3,
    items: [detail.items[0], unavailable, detail.items[1]]
  };
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(mixed)));
  const launch = vi.spyOn(playerStore, 'launchQueue').mockResolvedValue();
  renderPlaylistRoutes('/playlists/playlist-1');

  expect(await screen.findByRole('heading', { name: 'Quiet sequence' })).toBeInTheDocument();
  expect(screen.getByRole('list', { name: 'Quiet sequence Soundtracks' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Unavailable Soundtrack cannot be played' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Play' }));

  expect(launch).toHaveBeenCalledWith([
    expect.objectContaining({ id: firstTrack.id }),
    expect.objectContaining({ id: secondTrack.id })
  ], 0);
});
