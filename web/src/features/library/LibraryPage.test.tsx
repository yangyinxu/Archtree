import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { browserSessionQueryKey } from '../../api/session';
import { listenerCapabilitiesQueryKey } from '../../api/listenerCapabilities';
import { LibraryPage } from './LibraryPage';
import { privateLibraryPage, privatePlaylistSummary, privateViewerSession } from '../../../e2e/fixtures/privateListener';
import { trackFixtures } from '../../../e2e/fixtures/catalog';

const recent = { items: [{ content: trackFixtures[1], playedAt: '2026-09-07T12:00:00.000Z', saved: false }], limit: 20 };
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: {
  'Content-Type': 'application/json', 'X-Finitude-Account-Viewer': privateViewerSession.user.id
} });

/** Uses independent fixtures so a missing section cannot masquerade as saved content. */
const setup = (section = '', playlists = true) => {
  let saved = false;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname === '/api/listener/v1/capabilities') return response({ playlists });
    if (url.pathname === '/api/listener/v1/recently-played') return response({ ...recent, items: [{ ...recent.items[0], saved }] });
    if (url.pathname === '/content/me/playlists') return response({ items: [{ ...privatePlaylistSummary, itemCount: 0 }], nextCursor: null });
    if (url.pathname.startsWith('/content/me/saves/') && init?.method !== 'POST') {
      saved = init?.method === 'PUT';
      return response({ contentType: 'audioTrack', contentId: trackFixtures[1].id, saved });
    }
    if (url.pathname === '/api/listener/v1/library') {
      const type = url.searchParams.get('types');
      const q = url.searchParams.get('q')?.toLowerCase();
      return response({ items: privateLibraryPage.items.filter((item) => (!type || type === item.contentType)
        && (!q || (item.contentType === 'album' ? item.album.title : item.audioTrack.title).toLowerCase().includes(q))), nextCursor: null });
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(browserSessionQueryKey, privateViewerSession);
  client.setQueryData(listenerCapabilitiesQueryKey, { playlists });
  const renderTree = () => <QueryClientProvider client={client}><MemoryRouter initialEntries={[`/library${section}`]}><LibraryPage /></MemoryRouter></QueryClientProvider>;
  const view = render(renderTree());
  return { client, fetchMock, view, renderTree };
};

test('overview includes an empty owned playlist, saved content and unsaved history', async () => {
  setup();
  expect(await screen.findByRole('heading', { name: 'My Playlists' })).toBeInTheDocument();
  expect(await screen.findByText(privatePlaylistSummary.name)).toBeInTheDocument();
  const history = await screen.findByRole('region', { name: 'Recently played' });
  expect(await within(history).findByRole('button', { name: 'Save to Library' })).toBeInTheDocument();
  expect(within(history).getByText(/20 most recent/)).toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Saved music' })).toBeInTheDocument();
});

test('type filters are mutually exclusive and search changes the server query', async () => {
  const { fetchMock } = setup('?section=saved', false);
  const user = userEvent.setup();
  await screen.findAllByRole('button', { name: 'Remove from Library' });
  await user.click(screen.getByRole('button', { name: 'Albums' }));
  await user.click(screen.getByRole('button', { name: 'Songs' }));
  expect(screen.getByRole('button', { name: 'Albums' })).toHaveAttribute('aria-pressed', 'false');
  expect(screen.getByRole('button', { name: 'Songs' })).toHaveAttribute('aria-pressed', 'true');
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'unmatched' } });
  expect(await screen.findByText('Nothing matches these filters')).toBeInTheDocument();
  expect(fetchMock.mock.calls.some(([url]) => String(url).includes('types=audioTrack&q=unmatched'))).toBe(true);
});

test('a confirmed Save stays visible when refreshing history fails', async () => {
  const { fetchMock } = setup('?section=recent', false);
  const user = userEvent.setup();
  await screen.findByRole('button', { name: 'Save to Library' });
  const original = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (input, init) => String(input).includes('/api/listener/v1/recently-played')
    ? response({ message: 'Unavailable' }, 503)
    : original(input, init));
  await user.click(screen.getByRole('button', { name: 'Save to Library' }));
  expect(await screen.findByRole('button', { name: 'Remove from Library' })).toBeInTheDocument();
  expect(await screen.findByText('This section could not be loaded. Your other collections are still available.')).toBeInTheDocument();
  expect(screen.getByText(trackFixtures[1].title)).toBeInTheDocument();
});

test('save and unsave in recent playback retain the history row and its real button state', async () => {
  setup('?section=recent', false);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Save to Library' }));
  await user.click(await screen.findByRole('button', { name: 'Remove from Library' }));
  expect(await screen.findByRole('button', { name: 'Save to Library' })).toBeInTheDocument();
  expect(screen.getByText(trackFixtures[1].title)).toBeInTheDocument();
});

test('a failed history section leaves the saved section usable and retry recovers', async () => {
  const { fetchMock, client } = setup('', false);
  await screen.findByText(trackFixtures[1].title);
  fetchMock.mockImplementationOnce(async () => response({}, 500));
  await client.resetQueries({ queryKey: ['listener', 'library', privateViewerSession.user.id, 'recently-played'] });
  const history = screen.getByRole('region', { name: 'Recently played' });
  expect(await within(history).findByRole('alert')).toBeInTheDocument();
  expect(within(screen.getByRole('region', { name: 'Saved music' })).getAllByRole('button', { name: 'Remove from Library' }).length).toBeGreaterThan(0);
  await userEvent.setup().click(within(history).getByRole('button', { name: 'Try again' }));
  expect(await within(history).findByText(trackFixtures[1].title)).toBeInTheDocument();
});

test('disabled playlist capability hides its navigation and does not fetch playlists', async () => {
  const { fetchMock } = setup('', false);
  await screen.findByText(trackFixtures[1].title);
  expect(screen.queryByRole('link', { name: 'My Playlists' })).not.toBeInTheDocument();
  expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/content/me/playlists'))).toBe(false);
});

test('signing out immediately removes all private section content', async () => {
  const { client } = setup('', false);
  await screen.findByText(trackFixtures[1].title);
  client.setQueryData(browserSessionQueryKey, null);
  await waitFor(() => expect(screen.queryByText(trackFixtures[1].title)).not.toBeInTheDocument());
  expect(screen.getByRole('heading', { name: 'Log in to open your Library' })).toBeInTheDocument();
});
