import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { captureAccountOperation } from '../../api/accountEpoch';
import { adminWorkspace } from './adminWorkspace';
import { CatalogCover } from './CatalogCover';
import { json, session, viewer } from './adminFixtures.testSupport';
import type { CatalogItem } from './catalogApi';

/**
 * A deploy between page load and the first file choice removed the old hashed chunk of the upload helpers: the panel asks for a
 * reload in its own place, sends nothing and stays usable. All names and identifiers are synthetic.
 */
vi.mock('./catalogCoverUpload', () => { throw new TypeError('Failed to fetch dynamically imported module'); });

const item: CatalogItem = { kind: 'album', id: '222222222222222222222222', revision: `cr_${'a'.repeat(43)}`, visibility: 'public', effectiveVisibility: 'public', coverUrl: null, mediaUrl: null,
  capabilities: { editing: true, visibility: true }, fields: { title: 'Synthetic catalog Album', releaseDate: null, credits: null, attributionStatus: 'unknown' } };
beforeEach(() => { adminWorkspace.reset(); adminWorkspace.authorize(captureAccountOperation(viewer), true, true, undefined, { editing: true, visibility: true }); adminWorkspace.select('admin'); });
afterEach(() => { cleanup(); adminWorkspace.reset(); vi.unstubAllGlobals(); });

test('a failed load of the upload helpers asks for a reload, sends nothing and leaves the upload button usable', async () => {
  const requests: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string) => { requests.push(path); return json({ items: [] }); }));
  const client = new QueryClient(); client.setQueryData(['browser-session'], session);
  render(<QueryClientProvider client={client}><MemoryRouter><CatalogCover item={item} kind="album" id={item.id} disabled={false} onConfirmed={vi.fn()} onRemoved={vi.fn()} /></MemoryRouter></QueryClientProvider>);
  const upload = screen.getByRole('button', { name: 'Upload from this computer' }); await waitFor(() => expect(upload).toBeEnabled());
  const file = new File([Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])], 'cover.png'), read = vi.fn(async () => new ArrayBuffer(12));
  Object.defineProperty(file, 'arrayBuffer', { value: read });
  fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [file] } });
  expect(await screen.findByText('The administrator workbench was updated. Reload the page to continue; unsaved edits on this page are not kept.')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Reload page' })).toBeVisible();
  expect(adminWorkspace.getSnapshot().reloadRequired).toBe(false); expect(read).not.toHaveBeenCalled();
  expect(requests.filter(path => path.endsWith('/cover-uploads'))).toEqual([]);
  await waitFor(() => expect(upload).toBeEnabled());
});
