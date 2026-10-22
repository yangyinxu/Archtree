import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { captureAccountOperation } from '../../api/accountEpoch';
import { adminWorkspace } from './adminWorkspace';
import { ImportSummary } from './ImportSummary';
import { ImportApprovalChecklist } from './ImportApprovalChecklist';
import { AdminMutation } from './useAdminMutation';
import type { ImportUploadQueueView } from './useImportUploadQueue';
import { detail, json, lookupResponse, session, slotId, slotTwo, viewer } from './adminFixtures.testSupport';

/**
 * A deploy between page load and an append's summary or confirmation removed the old hashed expected-rows chunk: each asks for a
 * reload in the rows' place, and the page, Publish and the approval survive, since the rows are information only. All names and
 * identifiers are synthetic.
 */
vi.mock('./ImportExpectedRows', () => { throw new TypeError('Failed to fetch dynamically imported module'); });

const reload = 'The administrator workbench was updated. Reload the page to continue';
/** A saved append of both files as new members, with no pending Luna suggestion, to an Album whose expected tracklist has one missing row. */
function append() {
  const item = detail(); item.suggestions = []; item.publication = 'notStarted';
  item.decisions = [{ scope: 'album', slotId: null, entryKey: null, boundName: null, action: 'reuse', candidateId: '3'.repeat(24), candidateRevision: 'r-album' },
    ...[slotId, slotTwo].map(slot => ({ scope: 'track' as const, slotId: slot, entryKey: null, boundName: null, action: 'create-distinct' as const, candidateId: null, candidateRevision: null }))];
  const appendTracklist = { albumId: '3'.repeat(24), durationToleranceMs: 3000, rows: [{ discNumber: 1, trackNumber: 1, title: 'Opening', durationMs: null, filled: false }],
    files: [slotId, slotTwo].map(slot => ({ slotId: slot, durationMs: null, durationPrecisionMs: 0, appended: true })), numbering: [] };
  const response = lookupResponse({ revision: item.revision, summary: { ...lookupResponse().summary, append: true, appendTracklist } });
  const target = { kind: 'album', id: '3'.repeat(24), label: 'Existing Album', revision: 'r-album', albumId: null, visibility: 'public', match: 'name', matchedSlotIds: [], automaticReuse: false };
  vi.stubGlobal('fetch', vi.fn(async (path: string) => json(path.endsWith('/lookup') ? response : { items: [target], memberMatchesComplete: true })));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); client.setQueryData(['browser-session'], session);
  return { item, client };
}
beforeEach(() => { adminWorkspace.reset(); adminWorkspace.authorize(captureAccountOperation(viewer), true, true); adminWorkspace.select('admin'); });
afterEach(() => { cleanup(); adminWorkspace.reset(); vi.unstubAllGlobals(); });

test('an expected-rows chunk that cannot load asks for a reload in the summary, which keeps Publish available', async () => {
  const { item, client } = append(), onPublish = vi.fn();
  render(<QueryClientProvider client={client}><MemoryRouter><ImportSummary item={item} operation={new AdminMutation()} uploads={{ running: false } as unknown as ImportUploadQueueView}
    disabled={false} publishDisabled={false} approval={{ draft: item.draft, changes: [] }} onPublish={onPublish} /></MemoryRouter></QueryClientProvider>);
  expect(await screen.findByRole('alert')).toHaveTextContent(reload);
  expect(screen.getByRole('region', { name: 'Review and publish' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Review and approve publishing' })).toBeEnabled();
});

test('an expected-rows chunk that cannot load asks for a reload in the confirmation, whose approval stays available', async () => {
  const { item, client } = append(), onChange = vi.fn();
  render(<QueryClientProvider client={client}><MemoryRouter><ImportApprovalChecklist item={item} draft={item.draft} changes={[]} onChange={onChange} onAdopt={vi.fn()} /></MemoryRouter></QueryClientProvider>);
  const rows = (await screen.findByText('Album\'s expected tracklist', { selector: 'dt' })).nextElementSibling as HTMLElement;
  expect(await within(rows).findByRole('alert')).toHaveTextContent(reload);
  await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ ready: true })));
});
