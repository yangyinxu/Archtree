import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { browserSessionQueryKey } from '../../api/session';
import { advanceAccountEpoch } from '../../api/accountEpoch';
import type { SocialProfile } from '../../api/social';
import { SocialPage } from './SocialPage';
import { seedListenerCapabilities, type SocialRollout } from '../../test/listenerCapabilities';

vi.mock('./RoomsPanel', () => ({ RoomsPanel: () => <section aria-label="Listening room">Room surface</section> }));
const own: SocialProfile = { socialId: `s_${'a'.repeat(32)}`, handle: 'alice', alias: 'Alice', iconSeed: 'alice', active: true, discoverable: true, revision: 1 };
const peer = { socialId: `s_${'b'.repeat(32)}`, handle: 'bobby', alias: 'Bob', iconSeed: 'bob' };
let current: SocialProfile | null;
let mutations: Array<{ path: string; body: Record<string, unknown> }>;
let unknown = false;
let profileUnavailable = false;
let admissionDisabled = false;
let lastCommandId = '';
/** Mutation paths the synthetic server refuses with a recorded outcome code. */
let refusals: Record<string, string> = {};
const response = (body: unknown) => new Response(JSON.stringify(body), { headers: {
  'Content-Type': 'application/json', 'X-Finitude-Account-Viewer': 'viewer-1'
} });
beforeEach(() => {
  advanceAccountEpoch(); current = null; mutations = []; unknown = false; profileUnavailable = false; admissionDisabled = false; lastCommandId = '';
  refusals = {};
  vi.stubGlobal('fetch', vi.fn(async (path: string, options?: RequestInit) => {
    const body = options?.body ? JSON.parse(String(options.body)) : {};
    if (refusals[path] && options?.method !== 'GET' && body.commandId) {
      mutations.push({ path, body });
      return response({ commandId: body.commandId, outcome: 'rejected', code: refusals[path], replayed: false });
    }
    if (path === '/api/social/v1/me/profile' && options?.method === 'PATCH') {
      mutations.push({ path, body }); lastCommandId = body.commandId;
      current = { ...own, alias: body.alias, handle: body.handle, discoverable: body.discoverable };
      if (unknown) throw new TypeError('Synthetic acknowledgement loss');
      return response({ commandId: body.commandId, outcome: 'applied', replayed: false });
    }
    if (path === '/api/social/v1/me/profile') return profileUnavailable ? new Response(JSON.stringify({ code: 'social_unavailable' }), { status: 503 }) : response({ profile: current });
    if (path === '/api/social/v1/mutation-scopes') return response({ scopeToken: 'synthetic-scope-token-123', expiresAt: new Date(Date.now() + 60_000).toISOString() });
    if (path === '/api/social/v1/mutation-outcomes') return response({ outcome: { commandId: lastCommandId, outcome: 'applied', replayed: true } });
    if (path.startsWith('/api/social/v1/relationships?')) return response({ items: path.includes('kind=incoming') ? [{ socialId: peer.socialId, profile: peer, revision: 4 }] : [], nextCursor: null });
    if (path.startsWith('/api/social/v1/profiles?')) return response({ profile: peer });
    if (path === `/api/social/v1/relationships/${peer.socialId}`) return response({ relationship: { socialId: peer.socialId, state: 'none', revision: 3 } });
    if (admissionDisabled && path === '/api/social/v1/friend-requests') {
      mutations.push({ path, body });
      return new Response(JSON.stringify({ code: 'social_disabled', message: 'Social participation is disabled.' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    }
    if (options?.method === 'POST') { mutations.push({ path, body }); return response({ commandId: body.commandId, outcome: 'applied', replayed: false }); }
    throw new Error(`Unhandled synthetic request ${path}`);
  }));
});
const show = (signedIn = true, social?: SocialRollout) => {
  const client = seedListenerCapabilities(new QueryClient({ defaultOptions: { queries: { retry: false } } }), social);
  client.setQueryData(browserSessionQueryKey, signedIn ? { user: { id: 'viewer-1', email: 'private@example.invalid' } } : null);
  return render(<QueryClientProvider client={client}><MemoryRouter><SocialPage /></MemoryRouter></QueryClientProvider>);
};

test('signed-out route offers login without requesting social state', async () => {
  show(false);
  expect(screen.getByRole('heading', { name: 'Listen together' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Log in' })).toHaveAttribute('href', '/login');
  expect(screen.queryByText(/temporarily unavailable/)).not.toBeInTheDocument();
  expect(fetch).not.toHaveBeenCalled();
});

test('a disabled rollout explains Together while its existing relationships and safety actions stay reachable', async () => {
  current = own; admissionDisabled = true; show(true, { enabled: false, rooms: false });
  const unavailable = 'Together is temporarily unavailable. Removing friends, blocking and deactivating your profile still work.';
  expect(screen.getByText(unavailable)).toHaveAttribute('role', 'status');
  fireEvent.click(await screen.findByRole('tab', { name: 'Incoming requests' }));
  expect(await screen.findByRole('button', { name: 'Block' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Deactivate social profile' })).toBeEnabled();
  const form = screen.getByRole('form', { name: 'Find a friend' });
  fireEvent.change(within(form).getByLabelText('Handle'), { target: { value: 'bobby' } });
  fireEvent.submit(form);
  fireEvent.click(await screen.findByRole('button', { name: 'Add friend' }));
  // The definite feature-gate rejection is explained, not reported as a generic retryable failure.
  await waitFor(() => expect(screen.getAllByText(unavailable)).toHaveLength(2));
  expect(screen.queryByText('We could not complete that action. Try again.')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Check outcome' })).not.toBeInTheDocument();
  expect(mutations).toHaveLength(1);
});

test('identity setup saves the explicit alias without sharing private account identity', async () => {
  show();
  const form = await screen.findByRole('form', { name: 'Your social profile' });
  fireEvent.change(within(form).getByLabelText('Handle'), { target: { value: 'alice' } });
  fireEvent.change(within(form).getByLabelText('Display name'), { target: { value: 'Alice' } });
  fireEvent.submit(form);
  await screen.findByRole('button', { name: 'Save profile' });
  expect(mutations[0].body).toMatchObject({ handle: 'alice', alias: 'Alice', discoverable: true, expectedRevision: 0 });
  expect(JSON.stringify(mutations)).not.toContain('private@example.invalid');
  expect(screen.queryByText('private@example.invalid')).not.toBeInTheDocument();
  expect(within(screen.getByRole('form', { name: 'Your social profile' })).getByLabelText('Handle')).toBeDisabled();
  expect(await screen.findByRole('region', { name: 'Listening room' })).toBeInTheDocument();
});

test('finding a friend uses the latest visible relationship revision and incoming acceptance is explicit', async () => {
  current = own; show();
  const form = await screen.findByRole('form', { name: 'Find a friend' });
  fireEvent.change(within(form).getByLabelText('Handle'), { target: { value: 'bobby' } });
  fireEvent.submit(form);
  fireEvent.click(await screen.findByRole('button', { name: 'Add friend' }));
  await waitFor(() => expect(mutations[0]?.body).toMatchObject({ targetSocialId: peer.socialId, expectedRevision: 3 }));
  fireEvent.click(screen.getByRole('tab', { name: 'Incoming requests' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Accept' }));
  await waitFor(() => expect(mutations[1]).toMatchObject({ path: `/api/social/v1/relationships/${peer.socialId}/accept`, body: { expectedRevision: 4 } }));
});

test('unknown outcome exposes recovery without automatically repeating the profile mutation', async () => {
  unknown = true; show();
  const form = await screen.findByRole('form', { name: 'Your social profile' });
  fireEvent.change(within(form).getByLabelText('Handle'), { target: { value: 'alice' } });
  fireEvent.change(within(form).getByLabelText('Display name'), { target: { value: 'Alice' } });
  fireEvent.submit(form);
  fireEvent.click(await screen.findByRole('button', { name: 'Check outcome' }));
  await screen.findByRole('button', { name: 'Save profile' });
  expect(mutations).toHaveLength(1);
});

test('a failed background profile refresh preserves the current room and identity surface', async () => {
  current = own; show();
  const room = await screen.findByRole('region', { name: 'Listening room' });
  profileUnavailable = true;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await screen.findByRole('alert');
  expect(screen.getByRole('region', { name: 'Listening room' })).toBe(room);
  expect(screen.getByRole('button', { name: 'Save profile' })).toBeInTheDocument();
});

test('reporting a listener is an explicit, confirmed report with the chosen reason and optional note', async () => {
  current = own; show();
  fireEvent.click(await screen.findByRole('tab', { name: 'Incoming requests' }));
  const trigger = await screen.findByRole('button', { name: 'Report' });
  fireEvent.click(trigger);
  let dialog = await screen.findByRole('dialog', { name: 'Report this listener' });
  expect(within(dialog).getByText('Bob (@bobby)')).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(mutations).toHaveLength(0);

  fireEvent.click(screen.getByRole('button', { name: 'Report' }));
  dialog = await screen.findByRole('dialog', { name: 'Report this listener' });
  expect(within(dialog).getByRole('button', { name: 'Send report' })).toBeDisabled();
  fireEvent.click(within(dialog).getByLabelText('Harassment or bullying'));
  fireEvent.change(within(dialog).getByLabelText('Details (optional)'), { target: { value: '  Keeps sending requests  ' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Send report' }));
  await screen.findByText("Report sent. The listener won't be told who reported them.");
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(mutations).toHaveLength(1);
  expect(mutations[0].path).toBe('/api/social/v1/reports');
  expect(mutations[0].body).toMatchObject({ targetSocialId: peer.socialId, reason: 'harassment', note: 'Keeps sending requests' });
  expect(Object.keys(mutations[0].body).sort()).toEqual(['commandId', 'note', 'reason', 'scopeToken', 'targetSocialId']);
});

test('a suspended profile explains the suspension and cannot be edited or reactivated', async () => {
  current = { ...own, active: false, discoverable: false, revision: 4, suspended: true }; show();
  expect(await screen.findByText(/Your social profile is suspended/)).toBeInTheDocument();
  expect(screen.queryByText('Your social profile is inactive.')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Reactivate profile' })).toBeDisabled();
  expect(within(screen.getByRole('form', { name: 'Find a friend' })).getByRole('button', { name: 'Find' })).toBeDisabled();
  expect(screen.queryByRole('region', { name: 'Listening room' })).not.toBeInTheDocument();
});

test('a looked-up listener can be reported with only the chosen reason', async () => {
  current = own; show();
  const form = await screen.findByRole('form', { name: 'Find a friend' });
  fireEvent.change(within(form).getByLabelText('Handle'), { target: { value: 'bobby' } });
  fireEvent.submit(form);
  await screen.findByRole('button', { name: 'Add friend' });
  const lookup = form.closest('section')!;
  fireEvent.click(within(lookup).getByRole('button', { name: 'Report' }));
  const dialog = await screen.findByRole('dialog', { name: 'Report this listener' });
  fireEvent.click(within(dialog).getByLabelText('Something else'));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Send report' }));
  await waitFor(() => expect(mutations).toHaveLength(1));
  expect(mutations[0].body).toMatchObject({ targetSocialId: peer.socialId, reason: 'other' });
  expect('note' in mutations[0].body).toBe(false);
});

test('looking up your own handle never offers a self-report', async () => {
  const delegate = fetch as unknown as (path: string, options?: RequestInit) => Promise<Response>;
  const reads: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string, options?: RequestInit) => {
    if (path.startsWith('/api/social/v1/profiles?')) return response({ profile: { socialId: own.socialId, handle: own.handle, alias: own.alias, iconSeed: own.iconSeed } });
    if (path === `/api/social/v1/relationships/${own.socialId}`) { reads.push(path); return response({ relationship: null }); }
    return delegate(path, options);
  }));
  current = own; show();
  const form = await screen.findByRole('form', { name: 'Find a friend' });
  fireEvent.change(within(form).getByLabelText('Handle'), { target: { value: 'alice' } });
  fireEvent.submit(form);
  const lookup = form.closest('section')!;
  await within(lookup).findByText('@alice');
  await waitFor(() => expect(reads).toHaveLength(1));
  expect(within(lookup).queryByRole('button', { name: 'Report' })).not.toBeInTheDocument();
});

test('a taken handle is explained during setup and the handle stays editable for another choice', async () => {
  refusals['/api/social/v1/me/profile'] = 'handle_unavailable'; show();
  const form = await screen.findByRole('form', { name: 'Your social profile' });
  fireEvent.change(within(form).getByLabelText('Handle'), { target: { value: 'alice' } });
  fireEvent.change(within(form).getByLabelText('Display name'), { target: { value: 'Alice' } });
  fireEvent.submit(form);
  expect(await screen.findByText('That handle is taken or reserved. Choose a different handle.')).toHaveAttribute('role', 'status');
  expect(screen.queryByText('This changed while you were acting. The latest state is now shown.')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Check outcome' })).not.toBeInTheDocument();
  expect(within(screen.getByRole('form', { name: 'Your social profile' })).getByLabelText('Handle')).toBeEnabled();
  expect(mutations).toHaveLength(1);
});

test('accepting at the friend limit names the limit instead of a concurrent change', async () => {
  current = own; refusals[`/api/social/v1/relationships/${peer.socialId}/accept`] = 'social_limit'; show();
  fireEvent.click(await screen.findByRole('tab', { name: 'Incoming requests' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Accept' }));
  expect(await screen.findByText('One of you has reached the limit of 500 friends.')).toHaveAttribute('role', 'status');
  expect(screen.queryByText('This changed while you were acting. The latest state is now shown.')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Accept' })).toBeEnabled();
});
