import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ImportReview } from './ImportReview';
import { detail } from './adminFixtures.testSupport';
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
