import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { captureAccountOperation } from '../../api/accountEpoch';
import { adminWorkspace } from './adminWorkspace';
import { AdminCreateImportPage } from './AdminCreateImportPage';
import { json, session, viewer } from './adminFixtures.testSupport';

/**
 * A deploy removed the target card's chunk before a create page opened for an Album loaded it: the page asks for a reload where
 * the card would be, and the file choosers and Create stay disabled, so nothing is sent. All names and identifiers are synthetic.
 */
const cardChunk = vi.hoisted(() => ({ attempts: 0 }));
vi.mock('./ImportAlbumTargetCard', () => { cardChunk.attempts += 1; throw new TypeError('Failed to fetch dynamically imported module'); });

beforeEach(() => { adminWorkspace.reset(); adminWorkspace.authorize(captureAccountOperation(viewer), true, true); adminWorkspace.select('admin'); });
afterEach(() => { cleanup(); adminWorkspace.reset(); vi.unstubAllGlobals(); });

test('a target card chunk that cannot load asks for a reload in its place and keeps Create disabled without sending anything', async () => {
  const requests: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string) => { requests.push(path); return json({ item: null, receipt: null }); }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); client.setQueryData(['browser-session'], session);
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[`/admin/imports/new?album=${'f'.repeat(24)}`]}><Routes>
    <Route path="/admin/imports/new" element={<AdminCreateImportPage />} /></Routes></MemoryRouter></QueryClientProvider>);
  // React reveals a failed lazy child only after its Suspense throttle (about 300 ms).
  await waitFor(() => expect(cardChunk.attempts).toBeGreaterThan(0));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 600)); });
  expect(await screen.findByText(/Reload the page to continue/)).toHaveAttribute('role', 'alert');
  expect(screen.queryByRole('heading', { name: 'Upload new Album' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Choose audio files' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Choose folder' })).toBeDisabled();
  fireEvent.change(document.querySelectorAll('input[type=file]')[1], { target: { files: [new File(['synthetic bytes'], 'Song.mp3', { type: 'audio/mpeg' })] } });
  expect(screen.getByRole('button', { name: 'Create import and upload files' })).toBeDisabled();
  expect(requests.filter(path => path.includes('/imports'))).toEqual([]);
});
