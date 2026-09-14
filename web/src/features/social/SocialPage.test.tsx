import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { browserSessionQueryKey } from '../../api/session';
import { advanceAccountEpoch } from '../../api/accountEpoch';
import type { SocialProfile } from '../../api/social';
import { SocialPage } from './SocialPage';

vi.mock('./RoomsPanel', () => ({ RoomsPanel: () => <section aria-label="Listening room">Room surface</section> }));
const own: SocialProfile = { socialId: `s_${'a'.repeat(32)}`, handle: 'alice', alias: 'Alice', iconSeed: 'alice', active: true, discoverable: true, revision: 1 };
const peer = { socialId: `s_${'b'.repeat(32)}`, handle: 'bobby', alias: 'Bob', iconSeed: 'bob' };
let current: SocialProfile | null;
let mutations: Array<{ path: string; body: Record<string, unknown> }>;
let unknown = false;
let profileUnavailable = false;
let lastCommandId = '';
const response = (body: unknown) => new Response(JSON.stringify(body), { headers: {
  'Content-Type': 'application/json', 'X-Finitude-Account-Viewer': 'viewer-1'
} });
beforeEach(() => {
  advanceAccountEpoch(); current = null; mutations = []; unknown = false; profileUnavailable = false; lastCommandId = '';
  vi.stubGlobal('fetch', vi.fn(async (path: string, options?: RequestInit) => {
    const body = options?.body ? JSON.parse(String(options.body)) : {};
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
    if (options?.method === 'POST') { mutations.push({ path, body }); return response({ commandId: body.commandId, outcome: 'applied', replayed: false }); }
    throw new Error(`Unhandled synthetic request ${path}`);
  }));
});
const show = (signedIn = true) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(browserSessionQueryKey, signedIn ? { user: { id: 'viewer-1', email: 'private@example.invalid' } } : null);
  return render(<QueryClientProvider client={client}><MemoryRouter><SocialPage /></MemoryRouter></QueryClientProvider>);
};

test('signed-out route offers login without requesting social state', async () => {
  show(false);
  expect(screen.getByRole('heading', { name: 'Listen together' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Log in' })).toHaveAttribute('href', '/login');
  expect(fetch).not.toHaveBeenCalled();
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
