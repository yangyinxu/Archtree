import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { CatalogReviewApply, CatalogReviewChangeSummary } from './CatalogReviewApply';
import { catalogReview, slotId } from './catalogReviewFixtures.testSupport';
import { reviewChanges, reviewFieldKey, type CatalogReview, type ReviewChange } from './catalogReviewApi';

afterEach(cleanup);

function manualReview(): CatalogReview {
  const item = catalogReview();
  item.analysis = { ...item.analysis, state: 'idle', generation: 0, operationId: null, completedChunks: 0, totalChunks: 0, attemptsUsed: 0 };
  item.suggestions = [];
  item.source.album.title = item.source.tracks[0].title = 'Shared synthetic name';
  item.draft.album.title = 'Manual Album correction';
  item.draft.tracks[0].title = 'Manual track correction';
  return item;
}

function mount(item = manualReview(), selected: ReviewChange[] = []) {
  const onSelect = vi.fn(), onConfirm = vi.fn();
  render(<CatalogReviewApply item={item} changes={reviewChanges(item)} selected={selected} disabled={false} onSelect={onSelect} onConfirm={onConfirm} />);
  return { onSelect, onConfirm };
}

test('manual saved differences identify the original values and distinguish an Album from a same-named track without Luna', () => {
  const item = manualReview(), { onSelect } = mount(item);
  const album = screen.getByRole('checkbox', { name: 'Update Album · Shared synthetic name · Title' });
  const track = screen.getByRole('checkbox', { name: 'Update Track · Shared synthetic name · Title' });
  expect(within(album.closest('article')!).getByText('Original Album information')).toBeVisible();
  expect(within(album.closest('article')!).getByText('Value to apply')).toBeVisible();
  expect(within(album.closest('article')!).getByText('Manual Album correction')).toBeVisible();
  expect(within(track.closest('article')!).getByText('Manual track correction')).toBeVisible();
  expect(screen.queryByText('When analyzed')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Update original Album (0)' })).toBeDisabled();
  fireEvent.click(track);
  expect(onSelect).toHaveBeenCalledWith(reviewFieldKey(reviewChanges(item)[1]), true);
});

test('the counted update action confirms only explicitly selected saved fields', () => {
  const item = manualReview(), selected = [reviewChanges(item)[1]];
  const { onConfirm } = mount(item, selected);
  fireEvent.click(screen.getByRole('button', { name: 'Update original Album (1)' }));
  expect(onConfirm).toHaveBeenCalledWith([{ scope: 'track', slotId, field: 'title' }]);
  expect(screen.getByRole('checkbox', { name: 'Update Album · Shared synthetic name · Title' })).not.toBeChecked();
  expect(screen.getByRole('checkbox', { name: 'Update Track · Shared synthetic name · Title' })).toBeChecked();
});

test('a source that cannot be applied preserves readable differences and disables selection and confirmation', () => {
  const item = manualReview();
  item.sourceStatus = 'changed';
  item.capabilities.apply = false;
  const { onSelect, onConfirm } = mount(item, [reviewChanges(item)[0]]);
  screen.getAllByRole('checkbox').forEach(input => expect(input).toBeDisabled());
  const button = screen.getByRole('button', { name: 'Update original Album (1)' });
  expect(button).toBeDisabled();
  fireEvent.click(button);
  expect(onConfirm).not.toHaveBeenCalled();
  expect(onSelect).not.toHaveBeenCalled();
  expect(screen.getByText('Manual Album correction')).toBeVisible();
});

test('the confirmation summary presents the supplied old and new values without interactive selection', () => {
  const frozen = structuredClone(reviewChanges(manualReview())[1]);
  render(<CatalogReviewChangeSummary change={frozen} />);
  expect(screen.getByRole('heading', { name: 'Update Track · Shared synthetic name · Title' })).toBeVisible();
  expect(screen.getByText('Shared synthetic name')).toBeVisible();
  expect(screen.getByText('Manual track correction')).toBeVisible();
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});

test('a saved Disc Number difference is selectable as a Track Disc number change with its frozen old and new values', () => {
  const item = catalogReview(); item.suggestions = []; item.draft.tracks[0].discNumber = 2;
  const { onConfirm } = mount(item, reviewChanges(item));
  const disc = screen.getByRole('checkbox', { name: 'Update Track · Synthetic first track · Disc number' });
  expect(within(disc.closest('article')!).getByText('—')).toBeVisible();
  expect(within(disc.closest('article')!).getByText('2')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Update original Album (1)' }));
  expect(onConfirm).toHaveBeenCalledWith([{ scope: 'track', slotId, field: 'discNumber' }]);
});
