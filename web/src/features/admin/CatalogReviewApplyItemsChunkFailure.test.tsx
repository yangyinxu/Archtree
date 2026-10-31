import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { captureAccountOperation } from '../../api/accountEpoch';
import { adminWorkspace } from './adminWorkspace';
import type { ReviewField } from './catalogReviewApi';
import { CatalogReviewConfirmation } from './CatalogReviewConfirmation';
import { catalogReview, viewer } from './catalogReviewFixtures.testSupport';
import { reviewApplyModel } from './catalogReviewApplyModel';

/**
 * A deploy removed the read-only value views' chunk before the confirmation's full values were opened: they ask for a reload in
 * their place, while the compact rows above stay readable. All names and identifiers are synthetic.
 */
vi.mock('./CatalogReviewApplyItems', () => { throw new TypeError('Failed to fetch dynamically imported module'); });

beforeEach(() => {
  adminWorkspace.reset(); adminWorkspace.authorize(captureAccountOperation(viewer), true, true, undefined, { editing: true, visibility: true }); adminWorkspace.select('admin');
});
afterEach(() => { cleanup(); adminWorkspace.reset(); });

test('full values that cannot load ask for a reload in their place, and the compact rows stay readable', async () => {
  const item = catalogReview(); item.draft.album.title = 'Saved Album correction';
  const model = reviewApplyModel({ item, lookup: null, summary: null, waiting: null, identity: null, choices: { 'album::title': { checked: true, basis: '' } } });
  const title = model.items.find(entry => entry.field === 'title' && entry.scope === 'album')!;
  const fields: ReviewField[] = [{ scope: 'album', slotId: null, field: 'title' }];
  render(<CatalogReviewConfirmation frozen={{ item, extra: false, saved: false, numbersSaved: false, selection: { ...model.selection, fields, memberCredits: [], items: [title] } }}
    compared={false} applying={false} titleId="title" summaryId="summary" />);
  expect(screen.getByText('Album · Title')).toBeVisible();
  fireEvent.click(screen.getByText('Full original / new values · 1'));
  await waitFor(() => expect(screen.getByText(/Reload the page to continue/)).toHaveAttribute('role', 'alert'));
  expect(adminWorkspace.getSnapshot().reloadRequired).toBe(false);
  expect(screen.getByText('Album · Title')).toBeVisible();
});
