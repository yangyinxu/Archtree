import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { captureAccountOperation } from '../../api/accountEpoch';
import { adminWorkspace } from './adminWorkspace';
import { ImportMedia } from './ImportMedia';
import { AdminMutation } from './useAdminMutation';
import { loadImportUploadQueue, useImportUploadQueue } from './useImportUploadQueue';
import { detail, session, slotId, slotTwo, viewer } from './adminFixtures.testSupport';
import type { ComponentProps } from 'react';

// A deploy between page load and Publish removed the old hashed checklist chunk.
vi.mock('./ImportApprovalChecklist', () => { throw new TypeError('Failed to fetch dynamically imported module'); });

function Media(props: Omit<ComponentProps<typeof ImportMedia>, 'uploads'>) { return <ImportMedia {...props} uploads={useImportUploadQueue(props.item.id)} />; }
beforeAll(() => loadImportUploadQueue());
beforeEach(() => { adminWorkspace.reset(); adminWorkspace.authorize(captureAccountOperation(viewer), true, true); adminWorkspace.select('admin'); });
afterEach(() => { cleanup(); adminWorkspace.reset(); vi.unstubAllGlobals(); });

test('a checklist chunk that cannot load asks for a reload inside the dialog, keeps Approve disabled and sends nothing', async () => {
  const item = detail(); item.publication = 'notStarted'; item.capabilities.publish = true; item.draft.album.title = 'Synthetic Album';
  item.decisions = [{ scope: 'album', slotId: null, entryKey: null, boundName: null, action: 'create-distinct', candidateId: null, candidateRevision: null },
    ...[slotId, slotTwo].map(slot => ({ scope: 'track' as const, slotId: slot, entryKey: null, boundName: null, action: 'create-distinct' as const, candidateId: null, candidateRevision: null }))];
  const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
  const operation = new AdminMutation(), run = vi.spyOn(operation, 'run').mockImplementation(() => {});
  const client = new QueryClient(); client.setQueryData(['browser-session'], session);
  const changes = [{ path: 'album.title', base: 'Synthetic Album', value: 'Retitled Album' }];
  render(<QueryClientProvider client={client}><MemoryRouter><Media item={item} operation={operation} disabled={false} view="publication"
    approval={{ draft: { ...item.draft, album: { ...item.draft.album, title: 'Retitled Album' } }, changes }} /></MemoryRouter></QueryClientProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Publish Album' }));
  const dialog = within(screen.getByRole('dialog'));
  expect(await dialog.findByRole('alert')).toHaveTextContent('The administrator workbench was updated. Reload the page to continue');
  // The page and its Publish view survive behind the dialog.
  expect(screen.getByRole('heading', { name: 'Publish' })).toBeInTheDocument();
  const approveButton = dialog.getByRole('button', { name: 'Publish Album' }); expect(approveButton).toBeDisabled();
  fireEvent.click(approveButton);
  expect(run).not.toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled();
  // Cancel closes the dialog and leaves Publish available again.
  fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Publish Album' })).toBeEnabled();
});
