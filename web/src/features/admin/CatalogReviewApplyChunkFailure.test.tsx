import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { captureAccountOperation } from '../../api/accountEpoch';
import { adminWorkspace } from './adminWorkspace';
import { CatalogReviewApply } from './CatalogReviewApply';
import { capturedCatalogReview, reviewJson, session, viewer } from './catalogReviewFixtures.testSupport';
import { guestHandle, reviewAfterLookup, reviewIdentityResponse, reviewLookupResponse } from './catalogReviewLookupFixtures.testSupport';

/**
 * A deploy between page load and opening Update original Album removed the old hashed chunk of the read-only value views: each
 * view asks for a reload in its own place, while the choices, their hold notes and the count stay usable. All names and
 * identifiers are synthetic.
 */
vi.mock('./CatalogReviewApplyItems', () => { throw new TypeError('Failed to fetch dynamically imported module'); });

beforeEach(() => {
  adminWorkspace.reset(); adminWorkspace.authorize(captureAccountOperation(viewer), true, true, undefined, { editing: true, visibility: true }); adminWorkspace.select('admin');
});
afterEach(() => { cleanup(); adminWorkspace.reset(); vi.unstubAllGlobals(); });

test('value views that cannot load ask for a reload in their place, while the choices, their hold notes and the count stay usable', async () => {
  const item = reviewAfterLookup(capturedCatalogReview()), identity = reviewIdentityResponse();
  identity.identities[0] = { ...identity.identities[0], needsAnswer: false, decision: { scope: 'artist', identity: guestHandle, boundName: 'Synthetic guest', boundMusicBrainzId: null,
    action: 'create-distinct', candidateId: null, candidateRevision: null } };
  vi.stubGlobal('fetch', vi.fn(async (path: string) => reviewJson(path.endsWith('/lookup') ? reviewLookupResponse() : identity)));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }), onChoose = vi.fn();
  client.setQueryData(['browser-session'], session);
  render(<QueryClientProvider client={client}><CatalogReviewApply item={item} choices={{}} disabled={false} onChoose={onChoose} onConfirm={vi.fn()} /></QueryClientProvider>);
  const artists = await screen.findByRole('checkbox', { name: 'Update Album · Synthetic catalog Album · Artists' });
  // One alert per value view and one for the identity lines, each in place of what it would show.
  await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(screen.getAllByRole('checkbox').length + 1));
  for (const alert of screen.getAllByRole('alert')) expect(alert).toHaveTextContent('The administrator workbench was updated. Reload the page to continue');
  expect(adminWorkspace.getSnapshot().reloadRequired).toBe(false);
  expect(screen.queryByText('Creates Synthetic guest as new')).not.toBeInTheDocument();
  expect(artists).toBeChecked();
  expect(screen.getByRole('checkbox', { name: 'Update Album · Synthetic catalog Album · Release date' })).toHaveAccessibleDescription('Answer its lookup conflict first');
  expect(screen.getByText('Selected changes: 4')).toBeVisible();
  fireEvent.click(artists);
  expect(onChoose).toHaveBeenCalledWith('album::artists', { checked: false, basis: JSON.stringify(item.draft.album.artists) });
});
