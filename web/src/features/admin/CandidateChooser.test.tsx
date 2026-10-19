import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { CandidateChooser } from './CandidateChooser';
import type { ImportLookupView } from './importLookupApi';

/**
 * The candidate chooser on its own: each candidate's status line and differences in the folded list, which values the tie view
 * repeats, how the applied release and an applied none are marked, and the disclosure of files whose duration or disc number is
 * unknown. All names and identifiers are synthetic.
 */
type Candidate = ImportLookupView['candidates'][number];
const release = (n: number) => `0000000b-0000-4000-8000-00000000000${n}`;
const key = (n: number) => `musicbrainz:${release(n)}`;
const comparison = (differences: ('trackCount' | 'discCount' | 'duration')[] = []) => ({ trackCount: { local: 2, candidate: 2 }, discCount: { local: null, candidate: 2 }, differences, unknownLocalDurations: 0, unknownCandidateDurations: 0 });
const candidate = (n: number, extra: Partial<Candidate> = {}): Candidate => ({ key: key(n), releaseId: release(n), status: 'matching', title: `Synthetic Album ${n}`, artist: 'Synthetic Lead', label: `Label ${n}`,
  catalogNumber: null, barcode: null, country: null, date: { year: 2021, month: 5, day: null }, formats: [], trackCount: 2, comparison: comparison(), groupKey: String(n).repeat(64), artistMismatch: false, ...extra });
const group = (n: number, tracks: [number, number, string][]) => ({ groupKey: String(n).repeat(64), representativeKey: key(n), memberKeys: [key(n)], proposal: { albumTitle: 'Synthetic Album',
  artists: [{ name: 'Synthetic Lead', role: 'primary' as const, joinPhrase: null }], label: 'Label', releaseDate: null, tracks: tracks.map(([discNumber, trackNumber, title]) => ({ discNumber, trackNumber, title })) } });
const view = (extra: Partial<ImportLookupView> = {}): ImportLookupView => ({ run: 2, state: 'complete', issue: null, outcome: 'candidates', input: { trigger: 'tags', submitted: null }, candidates: [], groups: [],
  preselection: null, disclosure: null, applied: null, staleFiles: [], needsAnswer: { tie: false, conflicts: [] }, blocking: false, ...extra });
const applied = (run: number, candidateKey: string | null): ImportLookupView['applied'] => ({ run, candidateKey, releaseId: null, choice: candidateKey ? 'chosen' : 'none', basis: candidateKey ? 'chosen' : null, values: [], conflicts: [], flagged: [] });
function mount(lookup: ImportLookupView, disabled = false) { const onChoose = vi.fn(); render(<CandidateChooser lookup={lookup} disabled={disabled} onChoose={onChoose} />); return onChoose; }
afterEach(cleanup);

test('the folded list gives each release its status, label, date and track count, and says how a non-matching one differs', () => {
  mount(view({ candidates: [candidate(1), candidate(2, { status: 'notMatching', groupKey: null, comparison: comparison(['discCount', 'duration']) }), candidate(3, { status: 'incomplete', label: null, date: null, trackCount: null, comparison: null }),
    candidate(4, { status: 'unverified', title: null, artist: null })] }));
  const [matching, differing, incomplete, unverified] = screen.getAllByRole('listitem').filter(item => item.querySelector('strong'));
  expect(within(matching).getByText('Matches these files · Label 1 · 2021-05 · 2 tracks')).toBeInTheDocument();
  expect(within(differing).getAllByRole('listitem').map(item => item.textContent)).toEqual(['Discs: — here, 2 on the release', 'Track durations differ']);
  expect(within(incomplete).getByText(/^Details could not be fetched/)).toBeInTheDocument();
  expect(unverified.querySelector('strong')!.textContent).toBe('—');
  expect(within(unverified).getByText(/^Not verified: some durations are unknown/)).toBeInTheDocument();
  // Missing evidence reads as a dash, never as an empty cell.
  expect([...matching.querySelectorAll('dd')].map(value => value.textContent)).toEqual(['—', '—', '—', '—']);
});

test('the tie view repeats only the values that differ, here the disc and track order, and needs one release or none', () => {
  const onChoose = mount(view({ candidates: [candidate(1), candidate(2)], groups: [group(1, [[1, 1, 'First'], [1, 2, 'Second']]), group(2, [[1, 1, 'First'], [2, 1, 'Second']])], needsAnswer: { tie: true, conflicts: [] } }));
  const tie = screen.getByRole('region', { name: 'Several releases match these files. Choose one, or none.' });
  const [first, second] = within(tie).getAllByRole('listitem');
  expect([...first.querySelectorAll('dt')].map(term => term.textContent)).toEqual(['Disc and track order', 'Barcode', 'Catalogue number', 'Country', 'Medium']);
  expect(second.querySelector('dd')!.textContent).toBe('1.1 First · 2.1 Second');
  // Each choice names the release it chooses.
  expect(within(second).getByRole('button', { name: 'Use this release' })).toHaveAccessibleDescription('Synthetic Album 2 · Synthetic Lead');
  fireEvent.click(within(tie).getByRole('button', { name: 'Use none of these' }));
  expect(onChoose).toHaveBeenCalledWith(null);
});

test('the release applied for this run is marked and cannot be chosen again, an applied none disables none, and an earlier run\'s choice marks nothing', () => {
  let onChoose = mount(view({ candidates: [candidate(1), candidate(2)], applied: applied(2, key(1)) }));
  expect(screen.getByRole('button', { name: 'Applied' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Use this release' })); expect(onChoose).toHaveBeenCalledWith(key(2));
  expect(screen.getByRole('button', { name: 'Use none of these' })).toBeEnabled();
  cleanup();
  mount(view({ candidates: [candidate(1)], applied: applied(2, null) }));
  expect(screen.getByRole('button', { name: 'Use none of these' })).toBeDisabled();
  cleanup();
  onChoose = mount(view({ candidates: [candidate(1)], applied: applied(1, key(1)) }));
  expect(screen.queryByRole('button', { name: 'Applied' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Use this release' })); expect(onChoose).toHaveBeenCalledWith(key(1));
  cleanup();
  mount(view({ candidates: [candidate(1)] }), true);
  for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled();
});

test('files whose duration or disc number is unknown are disclosed beside the releases, never counted as agreement, and nothing is said while all are known', () => {
  mount(view({ candidates: [candidate(1)], disclosure: { unknownLocalDurations: 2, unknownLocalDiscNumbers: 1 } }));
  expect(screen.getByText('Files with an unknown duration: 2. They are not counted as agreeing with any release.')).toBeInTheDocument();
  expect(screen.getByText('Files with an unknown disc number: 1. They are not counted as agreeing with any release.')).toBeInTheDocument();
  cleanup();
  // A tie shows the disclosure where the choice is made.
  mount(view({ candidates: [candidate(1), candidate(2)], groups: [group(1, [[1, 1, 'First']]), group(2, [[1, 1, 'Other']])], needsAnswer: { tie: true, conflicts: [] }, disclosure: { unknownLocalDurations: 0, unknownLocalDiscNumbers: 3 } }));
  const tie = screen.getByRole('region', { name: 'Several releases match these files. Choose one, or none.' });
  expect(within(tie).getByText('Files with an unknown disc number: 3. They are not counted as agreeing with any release.')).toBeInTheDocument();
  expect(screen.queryByText(/unknown duration/)).not.toBeInTheDocument();
  cleanup();
  for (const disclosure of [null, { unknownLocalDurations: 0, unknownLocalDiscNumbers: 0 }]) {
    mount(view({ candidates: [candidate(1)], disclosure }));
    expect(screen.queryByText(/not counted as agreeing/)).not.toBeInTheDocument();
    cleanup();
  }
});
