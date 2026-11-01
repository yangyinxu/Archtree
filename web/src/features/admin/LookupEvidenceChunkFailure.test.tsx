import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { pairingApplication, pairingEditions, pairingLookupResponse, pairingTimeline } from './catalogReviewLookupFixtures.testSupport';
import { LookupProgress } from './LookupProgress';

/**
 * A deploy removed the old hashed chunk of the import-evidence words: one alert asks for a reload with its button, the identifier
 * rows and the line naming the identifier that chose the release stay empty, and every other row still reads. All names and
 * identifiers are synthetic.
 */
vi.mock('./LookupEvidence', () => { throw new TypeError('Failed to fetch dynamically imported module'); });
afterEach(cleanup);

test('one alert asks for a reload when the evidence chunk cannot load, the identifier rows and the chosen line stay empty, and the other rows still read', async () => {
  const base = pairingLookupResponse().lookup!, steps = pairingTimeline().steps;
  const lookup = { ...base, timeline: pairingTimeline({ steps: [{ kind: 'releaseId', state: 'done', from: 'import' }, { kind: 'barcode', state: 'done' }, ...steps] }),
    preselection: { candidateKey: pairingEditions[0], basis: 'releaseId' as const, artistMismatch: false, notChecked: false },
    applied: { ...pairingApplication(pairingEditions[0], true), choice: 'preselected' as const, basis: 'releaseId' as const } };
  render(<MemoryRouter><LookupProgress lookup={lookup} now={Date.parse('2026-10-22T01:25:30.000Z')} albumHref={null} /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: 'Details' }));
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('The administrator workbench was updated. Reload the page to continue; unsaved edits on this page are not kept.');
  expect(within(alert).getByRole('button', { name: 'Reload page' })).toBeInTheDocument();
  expect(screen.getAllByRole('alert')).toHaveLength(1);
  expect(screen.getAllByText('The administrator workbench was updated. Reload the page to continue; unsaved edits on this page are not kept.')).toHaveLength(1);
  const rows = within(screen.getByRole('list', { name: 'Lookup steps' })).getAllByRole('listitem').map(item => item.textContent);
  expect(rows.slice(0, 3)).toEqual(['', '', '✓ Search by Album name and Artist: "Synthetic Live Album 2" · Synthetic Live Artist']);
  expect(screen.queryByText(/^Chosen automatically/)).not.toBeInTheDocument();
});
