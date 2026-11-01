import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { captureAccountOperation } from '../../api/accountEpoch';
import { adminWorkspace } from './adminWorkspace';
import { ImportApprovalChecklist, type ApprovalState } from './ImportApprovalChecklist';
import { artistEntry, detail, entryKey, json, lookupResponse, session, slotId, slotTwo, viewer } from './adminFixtures.testSupport';

/** A paired release whose second track adds one featured Artist without adding that Artist to the Album. */
function fixture() {
  const item = detail(); item.suggestions = []; item.draft.album.title = 'Lorem Album'; item.draft.album.artists = [artistEntry('Lorem Lead')];
  item.draft.tracks.forEach((track, index) => { track.title = `Song ${index + 1}`; track.discNumber = 1; track.trackNumber = index + 1; });
  const lead = { ...item.draft.album.artists[0], joinPhrase: ' feat. ', identity: entryKey(1) }, guest = { ...artistEntry('Ipsum Guest', entryKey(2), 'featured'), identity: entryKey(2) };
  const response = lookupResponse({ summary: { ...lookupResponse().summary, trackArtists: [{ slotId: slotTwo, entries: [lead, guest] }],
    trackIdentities: [{ key: guest.key, name: guest.name, musicBrainzId: null, slotIds: [slotTwo] }] } });
  return { item, response };
}
/** Mounts the actual approval checklist with synthetic account-fenced server reads. */
function mount(extra: { rename?: boolean; skip?: boolean } = {}) {
  const { item, response } = fixture();
  item.decisions = [{ scope: 'artist', slotId: null, entryKey: entryKey(2), boundName: 'Ipsum Guest', action: 'reuse', candidateId: 'b'.repeat(24), candidateRevision: 'old-guest' }];
  if (extra.skip) item.decisions = [{ scope: 'track', slotId: slotTwo, entryKey: null, boundName: null, action: 'skip', candidateId: null, candidateRevision: null }];
  vi.stubGlobal('fetch', vi.fn(async (path: string) => json(path.endsWith('/lookup') ? response : { items: [{ kind: 'artist', id: 'b'.repeat(24), label: 'Ipsum Guest', revision: 'old-guest', albumId: null, visibility: 'public', match: 'name', matchedSlotIds: [], automaticReuse: false }], memberMatchesComplete: true })));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); client.setQueryData(['browser-session'], session);
  const onChange = vi.fn<(state: ApprovalState | null) => void>(), draft = structuredClone(item.draft);
  if (extra.rename) draft.album.artists[0].name = 'Changed Lead';
  render(<QueryClientProvider client={client}><MemoryRouter><ImportApprovalChecklist item={item} draft={draft}
    changes={extra.rename ? [{ path: 'album.artists', base: item.draft.album.artists, value: draft.album.artists }] : []} onChange={onChange} onAdopt={vi.fn()} /></MemoryRouter></QueryClientProvider>);
  return { onChange, state: () => onChange.mock.lastCall?.[0] };
}
beforeEach(() => { adminWorkspace.reset(); adminWorkspace.authorize(captureAccountOperation(viewer), true, true); adminWorkspace.select('admin'); });
afterEach(() => { cleanup(); adminWorkspace.reset(); vi.unstubAllGlobals(); });

test('the confirmation lists track Artists with roles and identities, and deselection excludes a track-only identity from approval', async () => {
  const { state } = mount();
  const select = await screen.findByRole('checkbox', { name: 'Use track Artists for Disc 1 · Track 2 · Song 2' });
  await waitFor(() => expect(state()?.ready).toBe(true));
  expect(select).toBeChecked();
  expect(screen.getByText('Track Artists', { selector: 'dt' })).toBeInTheDocument();
  expect(screen.getByText('Ipsum Guest · Featured · Reuses Ipsum Guest')).toBeInTheDocument();
  expect(screen.getByText('Lorem Lead · Primary · joined by “ feat. ” · New')).toBeInTheDocument();
  expect(state()?.body.trackArtists).toEqual([{ slotId: slotTwo, selected: true }]);
  expect(state()?.body.decisions.some(decision => decision.entryKey === entryKey(2))).toBe(true);
  fireEvent.click(select);
  await waitFor(() => expect(state()?.body.trackArtists).toEqual([{ slotId: slotTwo, selected: false }]));
  expect(state()?.ready).toBe(true);
  expect(state()?.body.preselections.some(decision => decision.entryKey === entryKey(2))).toBe(false);
  expect(state()?.body.decisions.some(decision => decision.entryKey === entryKey(2))).toBe(false);
  expect(screen.getByText('Uses Album primary Artists: Lorem Lead')).toBeInTheDocument();
  expect(screen.queryByText('Ipsum Guest · Featured · Reuses Ipsum Guest')).not.toBeInTheDocument();
});

test('unsaved Album Artist edits hold approval until saved or undone, so track comparison cannot silently change', async () => {
  const { state } = mount({ rename: true });
  expect(await screen.findByText('Save or undo the Album Artist changes before reviewing these track Artists.')).toBeInTheDocument();
  await waitFor(() => expect(state()).not.toBeNull());
  expect(state()?.ready).toBe(false);
});

test('skipping a track excludes the Artist only it credits, without an invisible Artist decision holding approval', async () => {
  const { state } = mount({ skip: true });
  await waitFor(() => expect(state()?.ready).toBe(true));
  expect(state()?.body.preselections.some(decision => decision.entryKey === entryKey(2))).toBe(false);
  expect(state()?.body.decisions.some(decision => decision.entryKey === entryKey(2))).toBe(false);
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  expect(within(screen.getByText('Tracks', { selector: 'dt' }).nextElementSibling as HTMLElement).getAllByRole('listitem')).toHaveLength(1);
  expect(state()?.body.preselections.some(decision => decision.scope === 'track' && decision.slotId === slotId)).toBe(true);
});
