import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { captureAccountOperation } from '../../api/accountEpoch';
import { adminWorkspace } from './adminWorkspace';
import { reviewJson, session, viewer } from './catalogReviewFixtures.testSupport';
import { pairingLookupResponse, pairingReview, pairingTimeline } from './catalogReviewLookupFixtures.testSupport';
import { CatalogReviewSummary } from './CatalogReviewSummary';

/**
 * A deploy removed the old hashed chunk of the lookup steps: the steps are supplementary, so the summary leaves them out and asks
 * for nothing, while its status, retry and name box stay usable; only where the chunk carried the only next step, the link to an
 * Album that changed, it asks for a reload. All names and identifiers are synthetic.
 */
vi.mock('./LookupProgress', () => { throw new TypeError('Failed to fetch dynamically imported module'); });

beforeEach(() => {
  adminWorkspace.reset(); adminWorkspace.authorize(captureAccountOperation(viewer), true, true, undefined, { editing: true, visibility: true }); adminWorkspace.select('admin');
});
afterEach(() => { cleanup(); adminWorkspace.reset(); vi.unstubAllGlobals(); });

test('a step list chunk that cannot load leaves the summary, its retry and its name box usable and asks for nothing', async () => {
  const response = pairingLookupResponse();
  Object.assign(response.lookup!, { state: 'stopped', issue: 'grantExpired', timeline: pairingTimeline() });
  vi.stubGlobal('fetch', vi.fn(async () => reviewJson(response)));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); client.setQueryData(['browser-session'], session);
  const onRun = vi.fn();
  render(<QueryClientProvider client={client}><MemoryRouter>
    <CatalogReviewSummary item={pairingReview()} disabled={false} error={null} onRun={onRun} onFillNumbers={vi.fn()} /></MemoryRouter></QueryClientProvider>);
  const summary = await screen.findByRole('region', { name: 'Metadata lookup' });
  expect(await within(summary).findByText(/^Lookup stopped because it ran past its time limit/)).toHaveAttribute('role', 'status');
  const box = await within(summary).findByRole('group', { name: 'Look up by name' });
  fireEvent.click(within(summary).getByRole('button', { name: 'Retry lookup' }));
  expect(onRun).toHaveBeenCalledWith('lookup/retry', {});
  expect(within(box).getByRole('button', { name: 'Look up' })).toBeEnabled();
  // The failed chunk renders nothing in its place: no steps, record or alert.
  await waitFor(() => expect(within(summary).queryByRole('list', { name: 'Lookup steps' })).not.toBeInTheDocument());
  expect(within(summary).queryByText(/^Lookup log:/)).not.toBeInTheDocument();
  expect(within(summary).queryByRole('alert')).not.toBeInTheDocument();
  expect(adminWorkspace.getSnapshot().reloadRequired).toBe(false);
});

test('a step list chunk that cannot load asks for a reload where it carried the only next step, the Album link of a run that ended because the Album changed', async () => {
  const response = pairingLookupResponse();
  Object.assign(response.lookup!, { state: 'superseded', issue: 'projectClosed', applied: null, timeline: pairingTimeline() });
  response.lookup!.needsAnswer.conflicts = [];
  vi.stubGlobal('fetch', vi.fn(async () => reviewJson(response)));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); client.setQueryData(['browser-session'], session);
  render(<QueryClientProvider client={client}><MemoryRouter>
    <CatalogReviewSummary item={{ ...pairingReview(), sourceStatus: 'changed' }} disabled={false} error={null} onRun={vi.fn()} onFillNumbers={vi.fn()} /></MemoryRouter></QueryClientProvider>);
  const summary = await screen.findByRole('region', { name: 'Metadata lookup' });
  expect(await within(summary).findByText('This lookup ended because the Album or its tracks changed or are no longer ready.')).toHaveAttribute('role', 'status');
  expect(await within(summary).findByRole('alert')).toHaveTextContent(/^The administrator workbench was updated\. Reload the page to continue/);
  expect(within(summary).queryByRole('button', { name: 'Retry lookup' })).not.toBeInTheDocument();
  expect(within(summary).queryByRole('link', { name: 'Open the Album to start a new completion' })).not.toBeInTheDocument();
});
