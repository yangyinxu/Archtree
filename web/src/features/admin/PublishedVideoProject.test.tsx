import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import PublishedVideoProject from './PublishedVideoProject';
import { adminEndpointRequest } from './adminTransport';
import { adminWorkspace } from './adminWorkspace';
import { videoProject, videoViewer } from './videoUploadFixtures.testSupport';
import type { CatalogItem } from './catalogApi';
import { ApiError } from '../../api/client';

let active: boolean, current: CatalogItem;
const id = '111111111111111111111111';
vi.mock('./AdminAccess', () => ({ useAdminAccess: () => ({ active, viewerId: 'aaaaaaaaaaaaaaaaaaaaaaaa', epoch: 1, generation: 1 }), useAdminText: () => (key: string) => key }));
vi.mock('./adminPageText', () => ({ useAdminDeliveryText: () => (key: string) => key }));
vi.mock('./useAdminOnline', () => ({ useOnline: () => true }));
vi.mock('./adminTransport', () => ({ adminEndpointRequest: vi.fn() }));
vi.mock('./CatalogMediaPreview', () => ({ CatalogMediaPreview: ({ item }: { item: CatalogItem | null }) => item ? <video aria-label="synthetic published preview" src={item.mediaUrl ?? undefined} poster={item.coverUrl ?? undefined} /> : null }));
vi.mock('./CatalogCover', () => ({ CatalogCover: ({ item, disabled, approvalDisabled, onConfirmed }: { item: CatalogItem | null; disabled: boolean; approvalDisabled: boolean; onConfirmed: (item: CatalogItem) => void }) => <button disabled={disabled || approvalDisabled || !item} onClick={() => item && onConfirmed({ ...item, revision: `cr_${'b'.repeat(43)}`, coverUrl: null })}>synthetic cover change</button> }));

/** A completed project's original snapshot intentionally differs from its current catalog content. */
function completed() {
  const project = videoProject();
  project.stage = 'complete'; project.draft.title = 'Original upload title';
  project.publication = { ...project.publication, state: 'complete', mediaTrackId: id, coverUrl: `/api/admin/v1/catalog/audioTrack/${id}/artwork` };
  return project;
}
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const view = render(<QueryClientProvider client={client}><MemoryRouter><PublishedVideoProject project={completed()} /></MemoryRouter></QueryClientProvider>);
  return { ...view, client };
}
beforeEach(() => {
  active = true; adminWorkspace.reset();
  vi.spyOn(adminWorkspace, 'current').mockReturnValue(true);
  current = { id, kind: 'audioTrack', mediaType: 'video', revision: `cr_${'a'.repeat(43)}`, visibility: 'public', effectiveVisibility: 'public',
    coverUrl: `/api/admin/v1/catalog/audioTrack/${id}/artwork`, mediaUrl: `/api/admin/v1/catalog/audioTrack/${id}/media`, capabilities: { editing: true, visibility: true },
    fields: { title: 'Current published title', credits: null, attributionStatus: 'unknown', releaseDate: null, discNumber: null, trackNumber: null } };
  vi.mocked(adminEndpointRequest).mockResolvedValue({ item: current } as never);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

test('completed tasks play the current catalog source and offer its cover controls without reselecting the original', async () => {
  mount(); await screen.findByText('Current published title');
  expect(screen.getByLabelText('synthetic published preview')).toHaveAttribute('src', current.mediaUrl);
  expect(await screen.findByRole('button', { name: 'synthetic cover change' })).toBeEnabled();
  expect(screen.getByRole('img', { name: 'video.cover_preview' })).toHaveAttribute('src', `${current.coverUrl}?viewer=${videoViewer}`);
  expect(screen.queryByRole('button', { name: 'video.reselect' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'video.upload_original' })).not.toBeInTheDocument();
  expect(vi.mocked(adminEndpointRequest).mock.calls[0][0]).toBe(`/catalog/audioTrack/${id}`);
});

test('confirmed current artwork updates do not rewrite the completed upload history or retain its detached cover', async () => {
  const { client } = mount(); await screen.findByText('Current published title');
  fireEvent.click(await screen.findByRole('button', { name: 'synthetic cover change' }));
  await waitFor(() => expect(screen.queryByRole('img', { name: 'video.cover_preview' })).not.toBeInTheDocument());
  expect(screen.getByLabelText('synthetic published preview')).not.toHaveAttribute('poster');
  expect(screen.getByText('Original upload title')).toBeInTheDocument();
  expect(client.getQueryData<{ item: CatalogItem }>(['admin-imports', videoViewer, 1, 1, 'catalog', 'audioTrack', id])?.item.coverUrl).toBeNull();
});

test('an absent current cover never falls back to the historical publication artwork', async () => {
  current.coverUrl = null; vi.mocked(adminEndpointRequest).mockResolvedValue({ item: current } as never);
  mount(); await screen.findByText('Current published title');
  expect(screen.queryByRole('img', { name: 'video.cover_preview' })).not.toBeInTheDocument();
  expect(screen.getByText('video.cover_placeholder')).toBeInTheDocument();
});

test('a refused refresh drops cached private playback and artwork while leaving recovery available', async () => {
  mount(); await screen.findByText('Current published title');
  vi.mocked(adminEndpointRequest).mockRejectedValue(new ApiError('Refused', 'http', 403));
  fireEvent.click(screen.getByRole('button', { name: 'video.refresh_published' }));
  await screen.findByRole('alert');
  expect(screen.queryByLabelText('synthetic published preview')).not.toBeInTheDocument();
  expect(screen.queryByRole('img', { name: 'video.cover_preview' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'synthetic cover change' })).toBeDisabled();
});

test('leaving the authorized administrator view immediately removes current published content', async () => {
  const { rerender, client } = mount(); await screen.findByText('Current published title');
  active = false;
  rerender(<QueryClientProvider client={client}><MemoryRouter><PublishedVideoProject project={completed()} /></MemoryRouter></QueryClientProvider>);
  expect(screen.queryByText('Current published title')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('synthetic published preview')).not.toBeInTheDocument();
});
