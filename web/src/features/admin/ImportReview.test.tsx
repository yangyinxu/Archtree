import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ImportReview } from './ImportReview';
import { artistEntry, detail, entryKey } from './adminFixtures.testSupport';
afterEach(cleanup);

test('partial adoption contains only selected typed suggestions and never publishes or starts analysis', () => {
  const item = detail(), onAdopt = vi.fn(), onReject = vi.fn(), onSelect = vi.fn();
  render(<ImportReview draft={item.draft} suggestions={item.suggestions} selected={[item.suggestions[1].id]} onSelect={onSelect} onAdopt={onAdopt} onReject={onReject} disabled={false} />);
  fireEvent.click(screen.getByRole('button', { name: 'Apply selected' }));
  expect(onAdopt).toHaveBeenCalledExactlyOnceWith([item.suggestions[1].id]); expect(onReject).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Keep current values for remaining suggestions' }));
  expect(onReject).toHaveBeenCalledWith(item.suggestions.map(item => item.id));
  expect(screen.queryByRole('button', { name: /publish/i })).not.toBeInTheDocument();
});
test('three-way review shows manual changes, disables stale adoption and retains explicit rejection', () => {
  const item = detail(); item.draft.album.title = 'Manual correction';
  const onAdopt = vi.fn();
  render(<ImportReview draft={item.draft} suggestions={item.suggestions} selected={[item.suggestions[0].id]} onSelect={vi.fn()} onAdopt={onAdopt} onReject={vi.fn()} disabled={false} />);
  expect(screen.getByText('Manual correction')).toBeVisible(); expect(screen.getByText('Suggested Album')).toBeVisible();
  expect(screen.getAllByRole('checkbox')[0]).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Apply selected' })).toBeDisabled();
  expect(screen.getAllByRole('button', { name: 'Keep current' })[0]).toBeEnabled();
});


test('track review identifies its source file without expanding evidence or changing its selection label', () => {
  const item = detail(); item.manifest.files[0].relativePath = 'Mira Vale/Night Windows/01 First.mp3';
  render(<ImportReview draft={item.draft} filenames={item.manifest.files} suggestions={item.suggestions} selected={[]} onSelect={vi.fn()} onAdopt={vi.fn()} onReject={vi.fn()} disabled={false} />);
  const track = screen.getByRole('checkbox', { name: '1 · Track number' });
  expect(track).toHaveAccessibleDescription('Mira Vale/Night Windows/01 First.mp3');
  expect(screen.getByText('Mira Vale/Night Windows/01 First.mp3')).toBeVisible();
  expect(document.querySelectorAll('details[open]')).toHaveLength(0);
});

test('an empty catalog review uses its workflow guidance without adopting or rejecting suggestions', () => {
  const item = detail(), navigate = vi.fn(), onAdopt = vi.fn(), onReject = vi.fn();
  render(<ImportReview draft={item.draft} suggestions={[]} selected={[]} onSelect={vi.fn()} onAdopt={onAdopt} onReject={onReject} disabled={false}
    draftCopy="Saved suggestions still require a separate original Album update."
    emptyContent={<div><p>Luna has not run yet.</p><button onClick={navigate}>Edit the review draft</button></div>} />);
  expect(screen.getByText('Saved suggestions still require a separate original Album update.')).toBeVisible();
  expect(screen.queryByText('There are no pending suggestions.')).not.toBeInTheDocument();
  expect(onAdopt).not.toHaveBeenCalled(); expect(onReject).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Edit the review draft' }));
  expect(navigate).toHaveBeenCalledOnce();
  expect(onAdopt).not.toHaveBeenCalled(); expect(onReject).not.toHaveBeenCalled();
});

/** The review panes whose whole text is `text`: Artist entries read as several lines in one <pre>. */
const panes = (text: string) => screen.queryAllByText((_, element) => element?.tagName === 'PRE' && element.textContent === text);

test('an Artist entries suggestion is labelled Artists and compares bylines with each entry\'s role', () => {
  const item = detail(), onAdopt = vi.fn(); item.draft.album.artists = [artistEntry('Lorem')];
  const suggestion = { ...item.suggestions[0], id: 'eeeeeeeeeeeeeeeeeeeeeeee', field: 'artists' as const, baseline: [artistEntry('Lorem')],
    value: [{ ...artistEntry('Lorem'), joinPhrase: ' & ' }, artistEntry('Ipsum', entryKey(2), 'featured')] };
  render(<ImportReview draft={item.draft} suggestions={[suggestion]} selected={[suggestion.id]} onSelect={vi.fn()} onAdopt={onAdopt} onReject={vi.fn()} disabled={false} />);
  expect(screen.getByRole('checkbox', { name: 'Artists' })).toBeEnabled();
  // The saved baseline and the current draft, then the suggested entries.
  expect(panes('Lorem\n1. Lorem · Primary')).toHaveLength(2);
  expect(panes('Lorem & Ipsum\n1. Lorem · Primary\n2. Ipsum · Featured')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Apply selected' })); expect(onAdopt).toHaveBeenCalledExactlyOnceWith([suggestion.id]);
});

test('a role-only Artist suggestion shows the role difference although the byline is unchanged', () => {
  const item = detail(); item.draft.album.artists = [artistEntry('Lorem'), artistEntry('Ipsum', entryKey(2))];
  const suggestion = { ...item.suggestions[0], id: 'eeeeeeeeeeeeeeeeeeeeeeee', field: 'artists' as const, baseline: item.draft.album.artists,
    value: [artistEntry('Lorem'), artistEntry('Ipsum', entryKey(2), 'featured')] };
  render(<ImportReview draft={item.draft} suggestions={[suggestion]} selected={[]} onSelect={vi.fn()} onAdopt={vi.fn()} onReject={vi.fn()} disabled={false} />);
  expect(panes('Lorem, Ipsum\n1. Lorem · Primary\n2. Ipsum · Primary')).toHaveLength(2);
  expect(panes('Lorem, Ipsum\n1. Lorem · Primary\n2. Ipsum · Featured')).toHaveLength(1);
  expect(screen.queryByText('Already matches the current draft')).not.toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: 'Artists' })).toBeEnabled();
});
