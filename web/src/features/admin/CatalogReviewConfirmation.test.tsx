import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { captureAccountOperation } from '../../api/accountEpoch';
import { adminWorkspace } from './adminWorkspace';
import type { CatalogReview, ReviewField } from './catalogReviewApi';
import type { ApplyItem } from './catalogReviewApplyModel';
import { CatalogReviewConfirmation, CatalogReviewUnknown } from './CatalogReviewConfirmation';
import { catalogReview, slotId, viewer } from './catalogReviewFixtures.testSupport';
import { longAlbumReview } from './catalogReviewLookupFixtures.testSupport';
import type { CatalogReviewFrozen } from './useCatalogReviewPrepare';

/**
 * The inline confirmation and the unknown view, from a frozen selection: the summary sentence, the compact rows (grouped on a long
 * Album, an overwrite kept on its own row), the extra release data note, the full values rendered once opened, and the unknown
 * view's rows and notes. Every name and identifier is synthetic.
 */
beforeEach(() => {
  adminWorkspace.reset(); adminWorkspace.authorize(captureAccountOperation(viewer), true, true, undefined, { editing: true, visibility: true }); adminWorkspace.select('admin');
});
/** jsdom's own scrollIntoView (none), restored after a test replaces it. */
const scrollIntoView = Element.prototype.scrollIntoView;
afterEach(() => { cleanup(); adminWorkspace.reset(); Element.prototype.scrollIntoView = scrollIntoView; document.documentElement.style.scrollPaddingBottom = ''; });

/** A frozen selection of `item` that writes `fields`, with `items` as the range listed them. */
const frozen = (item: CatalogReview, fields: ReviewField[], items: ApplyItem[] = [], extra = false): CatalogReviewFrozen => ({ item, extra, saved: true, numbersSaved: true,
  selection: { fields, memberCredits: [], preselections: [], musicBrainzIds: [], items, identities: [], albumNote: null } });
/** A selected title, date or number item: its original and new value. */
const valueItem = (field: ReviewField, title: string, baseline: unknown, value: unknown): ApplyItem => ({ key: `${field.scope}:${field.slotId ?? ''}:${field.field}`, scope: field.scope,
  slotId: field.slotId, field: field.field, title, member: false, value: { kind: 'value', baseline, value }, selected: true, hold: null, offSlotIds: [], basis: '' });

test('the confirmation is a labelled non-modal region with its summary, compact rows and the unchanged artwork, audio and visibility', () => {
  const item = catalogReview(); item.draft.album.title = 'Saved Album correction'; item.draft.tracks[1] = { ...item.draft.tracks[1], discNumber: 1, trackNumber: 2, title: 'Second track cleaned' };
  const fields: ReviewField[] = [{ scope: 'album', slotId: null, field: 'title' }, { scope: 'track', slotId: item.draft.tracks[1].slotId, field: 'discNumber' },
    { scope: 'track', slotId: item.draft.tracks[1].slotId, field: 'trackNumber' }, { scope: 'track', slotId: item.draft.tracks[1].slotId, field: 'title' }];
  // Shown below the editing section, it scrolls into view at its nearest edge, clear of the sticky bar (the page's bottom scroll padding).
  const scrolled: Element[] = [];
  Element.prototype.scrollIntoView = vi.fn(function (this: Element, options?: boolean | ScrollIntoViewOptions) { expect(options).toEqual({ block: 'nearest' }); scrolled.push(this); });
  document.documentElement.style.scrollPaddingBottom = '96px';
  render(<CatalogReviewConfirmation frozen={frozen(item, fields, [], true)} compared={false} applying={false} titleId="title" summaryId="summary" />);
  const dialog = screen.getByRole('dialog', { name: 'Confirm this update' });
  expect(scrolled).toEqual([dialog]);
  expect(dialog.style.scrollMarginBottom).toBe('96px');
  expect(dialog).toHaveAttribute('aria-modal', 'false');
  expect(dialog).toHaveAccessibleDescription('The draft is saved and checked. 4 changes update the original Album after the final confirmation.');
  expect(screen.getByText('Synthetic catalog Album / Synthetic catalog Artist')).toBeVisible();
  expect(screen.getAllByRole('listitem').map(row => row.textContent)).toEqual(['Second track cleanedDisc 1 · Track 2 · Title change', 'Album · TitleChange']);
  // Never past tense before the update.
  expect(screen.queryByText(/updated/i)).not.toBeInTheDocument();
  expect(screen.getByRole('note')).toHaveTextContent('Extra release data was found and not added to this update.');
  expect(screen.getByText('Checked the saved numbers and this update\'s range.')).toBeVisible();
  expect(screen.getByText('Artwork, audio and visibility stay unchanged.')).toBeVisible();
});

test('on a long Album the uniform number fills and the title changes are one line each, a number replacing a stored value keeps its row, and the full values render once opened', async () => {
  const item = longAlbumReview();
  item.draft.tracks = item.draft.tracks.map((track, index) => ({ ...track, discNumber: index < 15 ? 1 : index < 30 ? 2 : 3, trackNumber: index < 15 ? index + 1 : index < 30 ? index - 14 : index - 29,
    title: track.title.replace(/^\d\.\d\d\./, '') }));
  const fields: ReviewField[] = item.draft.tracks.flatMap(track => (['discNumber', 'trackNumber', 'title'] as const).map(field => ({ scope: 'track' as const, slotId: track.slotId, field })));
  const first = item.draft.tracks[0];
  const replacing = valueItem({ scope: 'track', slotId: first.slotId, field: 'trackNumber' }, first.title, 7, 1);
  render(<CatalogReviewConfirmation frozen={frozen(item, fields, [replacing])} compared applying={false} titleId="title" summaryId="summary" />);
  expect(screen.getAllByRole('listitem').map(row => row.textContent)).toEqual(['Fill the Disc and Track Numbers of 43 tracks', 'Change the titles of 44 tracks',
    'Synthetic long song 1Disc 1 · Track 1']);
  expect(screen.getByText('Compared the saved numbers with the stored candidates again.')).toBeVisible();
  const full = screen.getByText('Full original / new values · 132');
  expect(screen.queryByRole('heading', { level: 3 })).not.toBeInTheDocument();
  fireEvent.click(full);
  expect(await screen.findByRole('heading', { name: 'Update Track · Synthetic long song 1 · Track number' })).toBeVisible();
});

test('the unknown view focuses its heading only once asked, keeps the frozen rows and says checking never updates twice; once checked, that the same operation may be sent again', async () => {
  const item = catalogReview(), fields: ReviewField[] = [{ scope: 'track', slotId, field: 'trackNumber' }];
  const view = render(<CatalogReviewUnknown frozen={frozen(item, fields)} queried={false} focus={false} />);
  const heading = screen.getByRole('heading', { name: 'The result of this update is not confirmed yet' });
  // A review opened with an unknown apply leaves the focus where it is; this page's own apply becoming unknown moves it here.
  expect(heading).not.toHaveFocus();
  view.rerender(<CatalogReviewUnknown frozen={frozen(item, fields)} queried={false} focus />);
  await waitFor(() => expect(heading).toHaveFocus());
  expect(screen.getByText('A lost connection does not mean the update failed. Check the result of this operation first.')).toBeVisible();
  expect(within(screen.getByRole('list')).getByText('Synthetic first track').nextElementSibling).toHaveTextContent('Track 1');
  expect(screen.getByText('This checks the same operation and never updates twice.')).toBeVisible();
  view.rerender(<CatalogReviewUnknown frozen={null} queried focus />);
  expect(screen.getByText('The original Album is not updated yet. You can send the same operation again.')).toBeVisible();
  expect(screen.queryByRole('list')).not.toBeInTheDocument();
});
