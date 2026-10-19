import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { captureAccountOperation } from '../../api/accountEpoch';
import { adminWorkspace } from './adminWorkspace';
import { ImportDuplicates } from './ImportDuplicates';
import type { ImportCandidate, ImportDecision } from './adminApi';
import { artistEntry, detail, entryKey, json, labelEntry, session, slotId, slotTwo, viewer } from './adminFixtures.testSupport';

/** Renders the duplicate panel for one project and returns the save callback. */
function mount(item = detail()) {
  const onSave = vi.fn(), client = new QueryClient(); client.setQueryData(['browser-session'], session);
  render(<QueryClientProvider client={client}><MemoryRouter><ImportDuplicates item={item} disabled={false} onSave={onSave} /></MemoryRouter></QueryClientProvider>);
  return onSave;
}
/** Each decision row's own label text (scope and name), without its select options. */
const rows = () => [...document.querySelectorAll('label')].map(label => [...label.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join(''));
const select = (index: number) => screen.getByRole('combobox', { name: `${index} · Decision` }) as HTMLSelectElement;
const decide = (index: number, value: string) => fireEvent.change(select(index), { target: { value } });
const distinct = (scope: ImportDecision['scope'], slot: string | null = null, key: string | null = null): ImportDecision => ({ scope, slotId: slot, entryKey: key, action: 'create-distinct', candidateId: null, candidateRevision: null });
const candidate = (kind: ImportCandidate['kind'], id: string, label: string): ImportCandidate => ({ kind, id, label, revision: `${id}-revision`, albumId: null, visibility: 'public', match: 'name', matchedSlotIds: [], automaticReuse: false });
/** Two primaries, one featured entry and a label, as the editor saves them. */
const several = () => {
  const item = detail(); item.draft.album.title = 'Synthetic Album';
  item.draft.album.artists = [{ ...artistEntry('Lorem Ensemble', entryKey(1)), joinPhrase: ' & ' }, artistEntry('Ipsum Quartet', entryKey(2)), artistEntry('Dolor Soloist', entryKey(3), 'featured')];
  item.draft.album.label = labelEntry('Sit Records'); return item;
};
const open = async () => { fireEvent.click(screen.getByRole('button', { name: 'Find matches' })); await screen.findByRole('button', { name: 'Save decisions' }); };
const reset = () => { cleanup(); adminWorkspace.reset(); adminWorkspace.authorize(captureAccountOperation(viewer), true, true); adminWorkspace.select('admin'); };
beforeEach(() => { reset(); vi.stubGlobal('fetch', vi.fn(async () => json({ items: [] }))); });
afterEach(() => { cleanup(); adminWorkspace.reset(); vi.unstubAllGlobals(); });

test('a single Artist entry is decided on its own row, and the saved decision names that entry', async () => {
  const item = detail(); item.draft.album.title = 'Synthetic Album'; item.draft.album.artists = [{ ...artistEntry('Lorem Ensemble'), joinPhrase: ' & ' }];
  const onSave = mount(item); await open();
  expect(rows()).toEqual(['Artist · Lorem Ensemble · Primary', 'Album · Synthetic Album', 'Track · Untitled Album', 'Track · Untitled Album']);
  decide(1, 'create-distinct'); decide(2, 'create-distinct');
  fireEvent.click(screen.getByRole('button', { name: 'Save decisions' }));
  expect(onSave).toHaveBeenCalledExactlyOnceWith([distinct('artist', null, entryKey(1)), distinct('album')]);
});

test('several entries and a label each get a row in draft order with their roles, and every saved decision names its entry or none', async () => {
  const onSave = mount(several()); await open();
  expect(rows()).toEqual(['Artist · Lorem Ensemble · Primary', 'Artist · Ipsum Quartet · Primary', 'Artist · Dolor Soloist · Featured', 'Label · Sit Records', 'Album · Synthetic Album', 'Track · Untitled Album', 'Track · Untitled Album']);
  for (const index of [1, 2, 3, 4, 5]) decide(index, 'create-distinct');
  fireEvent.click(screen.getByRole('button', { name: 'Save decisions' }));
  expect(onSave).toHaveBeenCalledExactlyOnceWith([distinct('artist', null, entryKey(1)), distinct('artist', null, entryKey(2)), distinct('artist', null, entryKey(3)), distinct('label'), distinct('album')]);
  // Only tracks may be skipped.
  expect([...select(1).options].map(option => option.value)).toEqual(['', 'create-distinct']);
  expect([...select(6).options].map(option => option.value)).toEqual(['', 'create-distinct', 'skip']);
});

test('an Artist another entry already reuses cannot be chosen again, and Organization candidates appear only on the label row', async () => {
  const artist = 'a'.repeat(24), label = 'b'.repeat(24), item = several();
  // Defensive: the server refuses two entries with one case-insensitive name, but whenever one Artist is shown on two rows the guard holds.
  item.draft.album.artists[1].name = 'lorem ensemble';
  vi.stubGlobal('fetch', vi.fn(async () => json({ items: [candidate('artist', artist, 'Lorem Ensemble'), candidate('organization', label, 'SIT RECORDS')] })));
  const onSave = mount(item); await open();
  const reuseOption = (index: number, id: string) => [...select(index).options].find(option => option.value === id);
  // Both same-named entries see the Artist; once the first reuses it, the second cannot.
  expect([reuseOption(1, artist)?.disabled, reuseOption(2, artist)?.disabled]).toEqual([false, false]);
  decide(1, artist);
  expect([reuseOption(1, artist)?.disabled, reuseOption(2, artist)?.disabled, reuseOption(3, artist)]).toEqual([false, true, undefined]);
  // The Organization is a candidate of the label row only, and links to its catalog page.
  expect([reuseOption(1, label), reuseOption(4, label)?.disabled]).toEqual([undefined, false]);
  expect(screen.getByRole('link', { name: 'SIT RECORDS' }).getAttribute('href')).toBe(`/admin/catalog/organization/${label}`);
  expect(screen.getAllByRole('link', { name: 'Lorem Ensemble' }).map(link => link.getAttribute('href'))).toEqual([`/admin/catalog/artist/${artist}`, `/admin/catalog/artist/${artist}`]);
  decide(4, label);
  fireEvent.click(screen.getByRole('button', { name: 'Save decisions' }));
  expect(onSave).toHaveBeenCalledExactlyOnceWith([
    { scope: 'artist', slotId: null, entryKey: entryKey(1), action: 'reuse', candidateId: artist, candidateRevision: `${artist}-revision` },
    { scope: 'label', slotId: null, entryKey: null, action: 'reuse', candidateId: label, candidateRevision: `${label}-revision` }
  ]);
});

test('an append shows entry and label rows as not applied and keeps their stored decisions in the saved set', async () => {
  const album = 'c'.repeat(24), item = several();
  item.decisions = [distinct('artist', null, entryKey(1)), distinct('label'), { scope: 'album', slotId: null, entryKey: null, action: 'reuse', candidateId: album, candidateRevision: 'album-revision' }];
  vi.stubGlobal('fetch', vi.fn(async () => json({ items: [candidate('album', album, 'Synthetic Album')] })));
  const onSave = mount(item); await open();
  expect(rows()).toEqual(['Album · Synthetic Album', 'Track · Untitled Album', 'Track · Untitled Album']);
  expect(screen.getAllByText('Not applied: this import adds tracks to an existing Album, so this needs no decision.')).toHaveLength(4);
  // Rows keep their positions: the entries and the label are rows 1 to 4 without a select.
  decide(6, 'create-distinct');
  fireEvent.click(screen.getByRole('button', { name: 'Save decisions' }));
  expect(onSave).toHaveBeenCalledExactlyOnceWith([...item.decisions, distinct('track', slotId)]);
});

test('decisions of removed entries or tracks are neither shown nor saved', async () => {
  const item = several();
  item.decisions = [distinct('artist', null, entryKey(9)), distinct('artist', null, entryKey(2)), distinct('track', '10000000-0000-4000-8000-0000000000ff'), distinct('track', slotTwo)];
  const onSave = mount(item); await open();
  expect([select(1).value, select(2).value, select(7).value]).toEqual(['', 'create-distinct', 'create-distinct']);
  decide(5, 'create-distinct');
  fireEvent.click(screen.getByRole('button', { name: 'Save decisions' }));
  expect(onSave).toHaveBeenCalledExactlyOnceWith([distinct('artist', null, entryKey(2)), distinct('track', slotTwo), distinct('album')]);
});
