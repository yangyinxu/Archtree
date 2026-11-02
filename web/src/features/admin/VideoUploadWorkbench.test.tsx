import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { VideoWorkbenchEntries } from './VideoUploadEntry';
import { VideoUploadQueue } from './VideoUploadQueue';
import { VideoUploadCover } from './VideoUploadCover';
import { adminEndpointRequest } from './adminTransport';
import { videoProject, videoViewer } from './videoUploadFixtures.testSupport';

vi.mock('./AdminAccess', () => ({ useAdminAccess: () => ({ active: true, viewerId: 'aaaaaaaaaaaaaaaaaaaaaaaa', epoch: 1, generation: 1, imports: true, conversion: false }), readCapabilities: vi.fn() }));
vi.mock('./adminPageText', () => ({ useAdminDeliveryText: () => (key: string) => key }));
vi.mock('./adminTransport', () => ({ adminEndpointRequest: vi.fn() }));
vi.mock('./useAdminOnline', () => ({ useOnline: () => true }));
let client: QueryClient;
beforeEach(() => { client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }); });
afterEach(() => { cleanup(); client.clear(); vi.clearAllMocks(); });
const mount = (element: React.ReactNode) => render(<QueryClientProvider client={client}><MemoryRouter>{element}</MemoryRouter></QueryClientProvider>);

test('all three workbench entries coexist, preserving the pre-existing Album and MP3 routes', () => {
  client.setQueryData(['admin-capabilities', videoViewer, 1], { videoUploads: { enabled: true } }); mount(<VideoWorkbenchEntries />);
  expect(screen.getByRole('link', { name: 'workbench.new' })).toHaveAttribute('href', '/admin/imports/new');
  expect(screen.getByRole('link', { name: 'video.new' })).toHaveAttribute('href', '/admin/videos/new');
  expect(screen.getByRole('link', { name: 'conversion.title' })).toHaveAttribute('href', '/admin/conversions');
});

test('missing private staging keeps the Video entry visibly unavailable without removing other tools', () => {
  client.setQueryData(['admin-capabilities', videoViewer, 1], { videoUploads: { enabled: false } }); mount(<VideoWorkbenchEntries />);
  expect(screen.getByRole('button', { name: 'video.new' })).toBeDisabled(); expect(screen.getByText('video.unavailable')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'workbench.new' })).toBeInTheDocument(); expect(screen.getByRole('link', { name: 'conversion.title' })).toBeInTheDocument();
});

test('older private projects remain reachable through the real server cursor', async () => {
  const first = videoProject(), older = { ...videoProject(), id: 'dddddddddddddddddddddddd', draft: { ...videoProject().draft, title: 'Older task' } };
  vi.mocked(adminEndpointRequest).mockImplementation(async path => ({ schemaVersion: 1, items: path.includes('cursor=') ? [older] : [first], nextCursor: path.includes('cursor=') ? null : 'cccccccccccccccccccccccc' }) as never);
  mount(<VideoUploadQueue />); await screen.findByRole('link', { name: 'Synthetic Video' });
  fireEvent.click(screen.getByRole('button', { name: 'workbench.more' })); await screen.findByRole('link', { name: 'Older task' });
  expect(vi.mocked(adminEndpointRequest).mock.calls.some(([path]) => path === '/video-projects?cursor=cccccccccccccccccccccccc')).toBe(true);
});

test('a published cover uses its attached catalog artwork after temporary candidates are deleted', () => {
  const project = videoProject(), mediaTrackId = 'dddddddddddddddddddddddd';
  project.stage = 'complete'; project.publication = { ...project.publication, state: 'complete', mediaTrackId, coverUrl: `/api/admin/v1/catalog/audioTrack/${mediaTrackId}/artwork?viewer=${videoViewer}` };
  mount(<VideoUploadCover project={project} draft={project.draft} disabled localUrl={null} onImage={vi.fn()} onChoice={vi.fn()} onFrame={vi.fn()} />);
  expect(screen.getByRole('img', { name: 'video.cover_preview' })).toHaveAttribute('src', project.publication.coverUrl);
  expect(screen.getByText('video.cover_published')).toBeInTheDocument();
});

test('no dedicated cover displays actual inherited Album artwork rather than suppressing it', () => {
  const project = videoProject(), albumId = 'eeeeeeeeeeeeeeeeeeeeeeee';
  project.draft.coverChoice = 'none'; project.references.album = { id: albumId, title: 'Album', revision: 'revision', visibility: 'hidden', coverUrl: `/api/admin/v1/catalog/album/${albumId}/artwork?viewer=${videoViewer}` };
  mount(<VideoUploadCover project={project} draft={project.draft} disabled localUrl={null} onImage={vi.fn()} onChoice={vi.fn()} onFrame={vi.fn()} />);
  expect(screen.getByRole('img', { name: 'video.cover_preview' })).toHaveAttribute('src', project.references.album.coverUrl);
  expect(screen.getByText('video.cover_inherited')).toBeInTheDocument();
});
