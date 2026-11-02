import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { captureAccountOperation } from '../../api/accountEpoch';
import { adminWorkspace } from './adminWorkspace';
import { AdminCatalogPage } from './AdminCatalogPage';
import { json, session, viewer } from './adminFixtures.testSupport';
import { catalogItemSchema, type CatalogItem } from './catalogApi';

const id = '111111111111111111111111';
/** A private ready MediaTrack can change media kind independently of an unsaved metadata draft. */
const track = (mediaType?: 'audio' | 'video'): Extract<CatalogItem, { kind: 'audioTrack' }> => ({
  kind: 'audioTrack', id, revision: `cr_${'a'.repeat(43)}`, visibility: 'hidden', effectiveVisibility: 'hidden',
  coverUrl: `/api/admin/v1/catalog/audioTrack/${id}/artwork`, mediaUrl: `/api/admin/v1/catalog/audioTrack/${id}/media`,
  ...(mediaType ? { mediaType } : {}), capabilities: { editing: true, visibility: true },
  fields: { title: 'Synthetic saved Video', releaseDate: null, credits: null, attributionStatus: 'unknown', discNumber: null, trackNumber: null }
});
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); client.setQueryData(['browser-session'], session);
  render(<QueryClientProvider client={client}><MemoryRouter><AdminCatalogPage kind="audioTrack" id={id} /></MemoryRouter></QueryClientProvider>);
}
beforeEach(() => {
  adminWorkspace.reset(); adminWorkspace.authorize(captureAccountOperation(viewer), true, true, undefined, { editing: true, visibility: true }, true); adminWorkspace.select('admin');
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {}); vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
});
afterEach(() => { cleanup(); adminWorkspace.reset(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

test('a saved Video uses native video controls and protected artwork, without offering Audio-only MP3 conversion', async () => {
  const item = track('video');
  vi.stubGlobal('fetch', vi.fn(async (path: string) => path.endsWith('/cover-operations') ? json({ items: [] }) : json({ item })));
  mount(); await screen.findByRole('heading', { name: item.fields.title, level: 1 });
  const video = screen.getByLabelText(/^Private (?:audio|video) preview$/);
  expect(video.tagName).toBe('VIDEO'); expect(video).toHaveAttribute('controls'); expect(video).toHaveAttribute('playsinline');
  expect(video).toHaveAttribute('src', `${item.mediaUrl}?viewer=${viewer}`); expect(video).toHaveAttribute('poster', `${item.coverUrl}?viewer=${viewer}`);
  expect(document.querySelector('audio')).toBeNull(); expect(screen.queryByRole('link', { name: 'Convert to MP3' })).not.toBeInTheDocument();
  act(() => adminWorkspace.select('user'));
  expect(document.querySelector('video')).toBeNull(); expect(video).not.toHaveAttribute('src');
  expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled(); expect(HTMLMediaElement.prototype.load).toHaveBeenCalled();
});

test.each([undefined, 'audio'] as const)('legacy and explicit Audio retain native audio controls and conversion (%s)', async mediaType => {
  const item = track(mediaType);
  vi.stubGlobal('fetch', vi.fn(async (path: string) => path.endsWith('/cover-operations') ? json({ items: [] }) : json({ item })));
  mount(); await screen.findByRole('heading', { name: item.fields.title, level: 1 });
  expect(screen.getByLabelText(/^Private (?:audio|video) preview$/).tagName).toBe('AUDIO'); expect(document.querySelector('video')).toBeNull();
  expect(screen.getByRole('link', { name: 'Convert to MP3' })).toHaveAttribute('href', `/admin/conversions?track=${id}`);
});

test('a newer saved media kind replaces and stops the preview while preserving unsaved metadata', async () => {
  let item = track('video');
  vi.stubGlobal('fetch', vi.fn(async (path: string) => path.endsWith('/cover-operations') ? json({ items: [] }) : json({ item })));
  mount(); const title = await screen.findByRole('textbox', { name: 'Title' });
  fireEvent.change(title, { target: { value: 'Unsaved local title' } });
  const previous = document.querySelector('video')!;
  item = { ...track('audio'), revision: `cr_${'b'.repeat(43)}` };
  fireEvent.click(screen.getAllByRole('button', { name: 'Refresh status' })[0]);
  await waitFor(() => expect(document.querySelector('audio')).not.toBeNull());
  expect(title).toHaveValue('Unsaved local title'); expect(previous).not.toHaveAttribute('src');
  expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled(); expect(document.querySelector('video')).toBeNull();
});

test('refreshing a same-revision failed preview replaces its native element for an explicit retry', async () => {
  const item = track('video');
  vi.stubGlobal('fetch', vi.fn(async (path: string) => path.endsWith('/cover-operations') ? json({ items: [] }) : json({ item })));
  mount(); await screen.findByRole('heading', { name: item.fields.title, level: 1 }); const previous = document.querySelector('video')!;
  fireEvent.click(screen.getAllByRole('button', { name: 'Refresh status' })[0]);
  await waitFor(() => expect(document.querySelector('video')).not.toBe(previous));
  expect(previous).not.toHaveAttribute('src'); expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
});

test('media kind stays outside editable fields and rejects unsupported catalog media declarations', () => {
  expect(catalogItemSchema.parse(track('video'))).toMatchObject({ mediaType: 'video' });
  expect(catalogItemSchema.safeParse({ ...track(), mediaType: 'unknown' }).success).toBe(false);
  expect(catalogItemSchema.safeParse({ ...track(), fields: { ...track().fields, mediaType: 'video' } }).success).toBe(false);
});
