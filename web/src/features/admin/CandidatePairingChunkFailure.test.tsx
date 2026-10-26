import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CandidateChooser } from './CandidateChooser';
import { pairingEditions, pairingLookupResponse } from './catalogReviewLookupFixtures.testSupport';

/**
 * A deploy removed the pairing panel's chunk before a possible match's card opened it: a reload request stands in its place after
 * the sections, and the cards' other choices and Use none of these stay usable. All names and identifiers are synthetic.
 */
const pairingChunk = vi.hoisted(() => ({ attempts: 0 }));
vi.mock('./CandidatePairing', () => { pairingChunk.attempts += 1; throw new TypeError('Failed to fetch dynamically imported module'); });
afterEach(cleanup);

test('a pairing panel whose chunk cannot load asks for a reload after the sections, and the card\'s other choices and Use none of these stay usable', async () => {
  const onChoose = vi.fn();
  render(<CandidateChooser projectId="aaaaaaaaaaaaaaaaaaaaaaaa" viewerId="bbbbbbbbbbbbbbbbbbbbbbbb" lookup={pairingLookupResponse().lookup!} disabled={false} onChoose={onChoose}
    review={{ tracks: [{ slotId: '10000000-0000-4000-8000-000000000001', title: 'Synthetic opening (Live)' }, { slotId: '10000000-0000-4000-8000-000000000002', title: 'Synthetic second song (Live)' }],
      searched: 'Synthetic Live Album 2', artists: ['Synthetic Live Artist -Romanized-'], fill: null }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Pair tracks by hand' }));
  await waitFor(() => expect(pairingChunk.attempts).toBeGreaterThan(0));
  // React reveals a failed lazy child only after its Suspense throttle (about 300 ms).
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 600)); });
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent(/^The administrator workbench was updated\. Reload the page to continue/);
  const notFit = screen.getByText('Releases that do not fit or could not be read (10)').closest('details')!, none = screen.getByRole('button', { name: 'Use none of these' });
  expect(notFit.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(alert.compareDocumentPosition(none) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const card = within(screen.getByRole('region', { name: 'Possible match (1 release)' }));
  const albumOnly = card.getByRole('button', { name: 'Use Album values only (title, Artists, label, release date)', hidden: true });
  for (const button of [none, albumOnly]) expect(button).toBeEnabled();
  fireEvent.click(albumOnly); expect(onChoose).toHaveBeenLastCalledWith(pairingEditions[0]);
  fireEvent.click(none); expect(onChoose).toHaveBeenLastCalledWith(null);
});
