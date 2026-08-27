import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

import type { AudioTrackSummary, HomeSection } from '../api/contentSchemas';
import { PaginatedPageSection } from './PaginatedPageSection';

const pageItemId = '64b000000000000000000001';
const track = (id: string, title: string): AudioTrackSummary => ({
  contentType: 'audioTrack',
  id,
  title,
  artworkUrl: '',
  artistNames: ['Finitude Ensemble'],
  albumId: null,
  albumTitle: null,
  duration: '3:00',
  mediaType: 'audio',
  streamUrl: `/content/mediaTrack/stream/${id}`
});
const embedded = track('embedded-track', 'Legacy embedded item');
const first = track('first-track', 'First cursor item');
const second = track('second-track', 'Second cursor item');
const restarted = track('restarted-track', 'Restarted first item');
const section: HomeSection = {
  id: pageItemId,
  title: 'Focus',
  presentation: 'list',
  items: [embedded]
};

const pageResponse = (
  items: AudioTrackSummary[],
  nextCursor: string | null,
  title = section.title
) => ({
  pageItem: {
    id: pageItemId,
    pageSlug: 'home',
    title,
    presentation: 'list',
    mode: 'manual',
    contentType: 'audioTrack'
  },
  items: items.map((item, order) => ({
    contentType: 'audioTrack',
    contentId: item.id,
    order
  })),
  included: { albums: [], audioTracks: items },
  limit: 20,
  nextCursor
});

const renderSection = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <PaginatedPageSection pageSlug="home" section={section} />
      </MemoryRouter>
    </QueryClientProvider>
  );
};

afterEach(() => vi.restoreAllMocks());

test('replaces embedded compatibility items and appends cursor pages in server order', async () => {
  const user = userEvent.setup();
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const cursor = new URL(String(input), 'https://finitude.test').searchParams.get('cursor');
    return new Response(JSON.stringify(cursor
      ? pageResponse([second], null)
      : pageResponse([first], 'next-page', 'Current Focus')), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  renderSection();

  expect(screen.getByText('Gathering music…')).toBeInTheDocument();
  expect(await screen.findByText('First cursor item')).toBeInTheDocument();
  expect(screen.queryByText('Legacy embedded item')).not.toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Current Focus' })).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Load more' }));
  expect(await screen.findByText('Second cursor item')).toBeInTheDocument();
  expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
    expect.stringContaining('First cursor item'),
    expect.stringContaining('Second cursor item')
  ]);
  expect(fetchMock.mock.calls.map(([path]) => String(path))).toEqual([
    `/api/listener/v1/pages/home/items/${pageItemId}?limit=20`,
    `/api/listener/v1/pages/home/items/${pageItemId}?limit=20&cursor=next-page`
  ]);
});

test('reports a stale cursor and restarts explicitly from the first page', async () => {
  const user = userEvent.setup();
  let firstPageLoads = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const cursor = new URL(String(input), 'https://finitude.test').searchParams.get('cursor');
    if (cursor) {
      return new Response(JSON.stringify({
        code: 'stale_collection_cursor',
        message: 'Collection changed.'
      }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    firstPageLoads += 1;
    return new Response(JSON.stringify(firstPageLoads === 1
      ? pageResponse([first], 'next-page')
      : pageResponse([restarted], null)), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  renderSection();

  await screen.findByText('First cursor item');
  await user.click(screen.getByRole('button', { name: 'Load more' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('The catalog could not be loaded');

  await user.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText('Restarted first item')).toBeInTheDocument();
  await waitFor(() => expect(screen.queryByText('First cursor item')).not.toBeInTheDocument());
  expect(firstPageLoads).toBe(2);
});
