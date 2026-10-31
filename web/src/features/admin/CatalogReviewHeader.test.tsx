import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { captureAccountOperation } from '../../api/accountEpoch';
import { adminWorkspace } from './adminWorkspace';
import type { CatalogReview } from './catalogReviewApi';
import { albumId, catalogAlbum, catalogReview, reviewJson, session, viewer } from './catalogReviewFixtures.testSupport';
import { CatalogReviewHeader } from './CatalogReviewHeader';

/**
 * The review page's header: the Album's artwork from the catalog Album read, the placeholder while that read is pending, fails or
 * finds none, the captured Album title as stored, the draft's primary Artists and the local track count. Every name is synthetic.
 */

beforeEach(() => {
  adminWorkspace.reset(); adminWorkspace.authorize(captureAccountOperation(viewer), true, true, undefined, { editing: true, visibility: true }); adminWorkspace.select('admin');
});
afterEach(() => { cleanup(); adminWorkspace.reset(); vi.unstubAllGlobals(); });

const artwork = `/api/admin/v1/catalog/album/${albumId}/artwork`;
function mount(item: CatalogReview, read: () => Response) {
  const fetch = vi.fn(async (path: string) => path === `/api/admin/v1/catalog/album/${albumId}` ? read() : reviewJson({ code: 'unexpected' }, 500));
  vi.stubGlobal('fetch', fetch);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); client.setQueryData(['browser-session'], session);
  render(<QueryClientProvider client={client}><CatalogReviewHeader item={item}><button type="button">Synthetic header action</button></CatalogReviewHeader></QueryClientProvider>);
  return { fetch, client };
}

test('the header shows the Album\'s current artwork, its title as stored with a trailing credit, its primary Artists, its local track count and the page\'s actions', async () => {
  const item = catalogReview(); item.source.album.title = 'Synthetic catalog Album／Synthetic catalog Artist';
  item.draft.album.artists.push({ key: '50000000-0000-4000-8000-000000000009', name: 'Synthetic featured guest', role: 'featured', joinPhrase: null, musicBrainzId: null });
  const { client } = mount(item, () => reviewJson({ item: { ...catalogAlbum(), coverUrl: artwork } }));
  // The placeholder holds the cover's place until the read lands.
  const cover = () => screen.getByRole('img', { name: 'Synthetic catalog Album／Synthetic catalog Artist cover' });
  await waitFor(() => expect(cover().tagName).toBe('IMG'));
  expect(cover().getAttribute('src')).toBe(`${artwork}?viewer=${viewer}`);
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Synthetic catalog Album／Synthetic catalog Artist');
  // Primary Artists only, then the tracks the review captured.
  expect(screen.getByText('Synthetic catalog Artist', { selector: 'strong' })).toBeVisible();
  expect(screen.queryByText(/Synthetic featured guest/)).not.toBeInTheDocument();
  expect(screen.getByText('2 local tracks', { exact: false })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Synthetic header action' })).toBeVisible();
  // The read is the Album page's own, under its query key.
  expect(client.getQueryData(['admin-imports', viewer, adminWorkspace.getSnapshot().epoch, adminWorkspace.getSnapshot().generation, 'catalog', 'album', albumId]))
    .toMatchObject({ item: { coverUrl: artwork } });
});

test('without artwork, or when its read fails or cannot be parsed, the header shows the artwork placeholder and asks for no reload', async () => {
  const placeholder = 'Synthetic catalog Album cover';
  for (const read of [() => reviewJson({ item: catalogAlbum() }), () => reviewJson({ code: 'unexpected' }, 500), () => reviewJson({ item: { unexpected: true } })]) {
    const { fetch } = mount(catalogReview(), read);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const cover = await screen.findByRole('img', { name: placeholder });
    expect(cover.tagName).toBe('SPAN');
    expect(adminWorkspace.getSnapshot().reloadRequired).toBe(false);
    cleanup();
  }
  // An Album no longer available is not read.
  const gone = catalogReview(); gone.sourceStatus = 'unavailable';
  const { fetch } = mount(gone, () => reviewJson({ item: catalogAlbum() }));
  expect(screen.getByRole('img', { name: placeholder }).tagName).toBe('SPAN');
  expect(fetch).not.toHaveBeenCalled();
});
