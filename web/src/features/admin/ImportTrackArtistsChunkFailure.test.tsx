import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { captureAccountOperation } from '../../api/accountEpoch';
import { adminWorkspace } from './adminWorkspace';
import { ImportApprovalChecklist } from './ImportApprovalChecklist';
import { artistEntry, detail, entryKey, json, lookupResponse, session, slotTwo, viewer } from './adminFixtures.testSupport';

/** A missing deploy chunk must never approve independent Credits the administrator cannot see. */
vi.mock('./ImportTrackArtists', () => { throw new TypeError('Failed to fetch dynamically imported module'); });
beforeEach(() => { adminWorkspace.reset(); adminWorkspace.authorize(captureAccountOperation(viewer), true, true); adminWorkspace.select('admin'); });
afterEach(() => { cleanup(); adminWorkspace.reset(); vi.unstubAllGlobals(); });

test('an unavailable Track Artists chunk asks for reload and keeps the approval locked', async () => {
  const item = detail(); item.suggestions = []; item.draft.album.title = 'Lorem Album'; item.draft.album.artists = [artistEntry('Lorem Lead')];
  const guest = artistEntry('Ipsum Guest', entryKey(2), 'primary');
  const response = lookupResponse({ summary: { ...lookupResponse().summary, trackArtists: [{ slotId: slotTwo, entries: [{ ...guest, identity: guest.key }] }],
    trackIdentities: [{ key: guest.key, name: guest.name, musicBrainzId: null, slotIds: [slotTwo] }] } });
  vi.stubGlobal('fetch', vi.fn(async (path: string) => json(path.endsWith('/lookup') ? response : { items: [], memberMatchesComplete: true })));
  const client = new QueryClient(); client.setQueryData(['browser-session'], session); const onChange = vi.fn();
  render(<QueryClientProvider client={client}><MemoryRouter><ImportApprovalChecklist item={item} draft={item.draft} changes={[]} onChange={onChange} onAdopt={vi.fn()} /></MemoryRouter></QueryClientProvider>);
  expect(await screen.findByRole('alert')).toHaveTextContent('The administrator workbench was updated. Reload the page to continue');
  await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ ready: false })));
  expect(screen.getByRole('region', { name: 'What becomes catalog content' })).toBeInTheDocument();
});
