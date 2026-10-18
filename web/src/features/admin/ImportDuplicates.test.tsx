import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { captureAccountOperation } from '../../api/accountEpoch';
import { adminWorkspace } from './adminWorkspace';
import { ImportDuplicates } from './ImportDuplicates';
import type { ImportDecision } from './adminApi';
import { artistEntry, detail, json, session, slotId, slotTwo, viewer } from './adminFixtures.testSupport';

/** Renders the duplicate panel for one project and returns the save callback. */
function mount(item = detail()) {
  const onSave = vi.fn(), client = new QueryClient(); client.setQueryData(['browser-session'], session);
  render(<QueryClientProvider client={client}><MemoryRouter><ImportDuplicates item={item} disabled={false} onSave={onSave} /></MemoryRouter></QueryClientProvider>);
  return onSave;
}
/** Each decision row's own label text (scope and name), without its select options. */
const rows = () => [...document.querySelectorAll('label')].map(label => [...label.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join(''));
const decide = (index: number, value: string) => fireEvent.change(screen.getByRole('combobox', { name: `${index} · Decision` }), { target: { value } });
const distinct = (scope: ImportDecision['scope'], slot: string | null = null): ImportDecision => ({ scope, slotId: slot, action: 'create-distinct', candidateId: null, candidateRevision: null });
beforeEach(() => {
  adminWorkspace.reset(); adminWorkspace.authorize(captureAccountOperation(viewer), true, true); adminWorkspace.select('admin');
  vi.stubGlobal('fetch', vi.fn(async () => json({ items: [] })));
});
afterEach(() => { cleanup(); adminWorkspace.reset(); vi.unstubAllGlobals(); });

test('a single Artist entry without a label is decided as the Artist row, named by that entry', async () => {
  const item = detail(); item.draft.album.title = 'Synthetic Album'; item.draft.album.artists = [{ ...artistEntry('Lorem Ensemble'), joinPhrase: ' & ' }];
  const onSave = mount(item);
  fireEvent.click(screen.getByRole('button', { name: 'Find matches' }));
  await screen.findByRole('button', { name: 'Save decisions' });
  expect(rows()).toEqual(['Artist · Lorem Ensemble', 'Album · Synthetic Album', 'Track · Untitled Album', 'Track · Untitled Album']);
  decide(1, 'create-distinct'); decide(2, 'create-distinct');
  fireEvent.click(screen.getByRole('button', { name: 'Save decisions' }));
  expect(onSave).toHaveBeenCalledExactlyOnceWith([distinct('artist'), distinct('album')]);
});

test('several Artist entries or a label show no Artist row and never save an Artist decision', async () => {
  for (const change of [
    (item: ReturnType<typeof detail>) => { item.draft.album.artists = [artistEntry('Lorem'), { ...artistEntry('Ipsum', '30000000-0000-4000-8000-000000000002'), role: 'featured' }]; },
    (item: ReturnType<typeof detail>) => { item.draft.album.artists = [artistEntry('Lorem')]; item.draft.album.label = { name: 'Synthetic Label', musicBrainzId: null }; }
  ]) {
    // A saved Artist decision from before the entries changed is left out of the next save.
    const item = detail(); item.draft.album.title = 'Synthetic Album'; item.decisions = [distinct('artist'), distinct('track', slotId)]; change(item);
    const onSave = mount(item);
    fireEvent.click(screen.getByRole('button', { name: 'Find matches' }));
    await screen.findByRole('button', { name: 'Save decisions' });
    expect(rows()).toEqual(['Album · Synthetic Album', 'Track · Untitled Album', 'Track · Untitled Album']);
    decide(1, 'create-distinct');
    fireEvent.click(screen.getByRole('button', { name: 'Save decisions' }));
    expect(onSave).toHaveBeenCalledExactlyOnceWith([distinct('track', slotId), distinct('album')]);
    expect(onSave.mock.calls[0][0].some((decision: ImportDecision) => decision.scope === 'artist' || decision.slotId === slotTwo)).toBe(false);
    cleanup(); adminWorkspace.reset(); adminWorkspace.authorize(captureAccountOperation(viewer), true, true); adminWorkspace.select('admin');
  }
});
