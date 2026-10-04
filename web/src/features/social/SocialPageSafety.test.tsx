import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { MockInstance } from 'vitest';
import { MemoryRouter } from 'react-router';
import { browserSessionQueryKey } from '../../api/session';
import { advanceAccountEpoch } from '../../api/accountEpoch';
import type { SocialCard, SocialListKind, SocialProfile } from '../../api/social';
import { roomSession } from './roomSession';
import { SocialPage } from './SocialPage';

vi.mock('./RoomsPanel', () => ({ RoomsPanel: () => <section aria-label="Listening room">Room surface</section> }));

type Row = { socialId: string; profile: SocialCard | null; revision: number };
const own: SocialProfile = { socialId: `s_${'a'.repeat(32)}`, handle: 'alice', alias: 'Alice', iconSeed: 'alice', active: true, discoverable: true, revision: 1 };
const bob: SocialCard = { socialId: `s_${'b'.repeat(32)}`, handle: 'bobby', alias: 'Bob', iconSeed: 'bob' };
const carol: SocialCard = { socialId: `s_${'c'.repeat(32)}`, handle: 'carol', alias: 'Carol', iconSeed: 'carol' };
const row = (card: SocialCard, revision: number): Row => ({ socialId: card.socialId, profile: card, revision });
const scopeToken = 'synthetic-scope-token-123';

let profile: SocialProfile;
let lists: Record<SocialListKind, Row[]>;
let sent: Array<{ path: string; body: Record<string, unknown> }>;
/** Mutation paths the synthetic server refuses with a durable outcome code instead of applying. */
let refusals: Record<string, string>;
let pairRevision: number;
let nativeConfirm: MockInstance<typeof window.confirm>;

/** Applies an accepted action to one pair the way the social service reports it on the next read. */
const applyRelationship = (socialId: string, action: string) => {
  const leave = (kind: SocialListKind) => { lists[kind] = lists[kind].filter(value => value.socialId !== socialId); };
  if (action === 'block') {
    for (const kind of ['friends', 'incoming', 'outgoing'] as const) leave(kind);
    // The private block list carries the opaque ID and revision, never the blocked person's card.
    lists.blocks = [...lists.blocks, { socialId, profile: null, revision: ++pairRevision }];
  } else leave(({ remove: 'friends', decline: 'incoming', cancel: 'outgoing', unblock: 'blocks' } as Record<string, SocialListKind>)[action]);
};
const response = (body: unknown) => new Response(JSON.stringify(body), { headers: {
  'Content-Type': 'application/json', 'X-Finitude-Account-Viewer': 'viewer-1'
} });

beforeEach(() => {
  advanceAccountEpoch();
  profile = own; lists = { friends: [], incoming: [], outgoing: [], blocks: [] }; sent = []; refusals = {}; pairRevision = 10;
  nativeConfirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.stubGlobal('fetch', vi.fn(async (path: string, options?: RequestInit) => {
    const method = options?.method ?? 'GET';
    const body = options?.body ? JSON.parse(String(options.body)) : {};
    if (path === '/api/social/v1/mutation-scopes') return response({ scopeToken, expiresAt: new Date(Date.now() + 60_000).toISOString() });
    if (method !== 'GET') {
      sent.push({ path, body });
      if (refusals[path]) return response({ commandId: body.commandId, outcome: 'rejected', code: refusals[path], replayed: false });
      const relationship = /^\/api\/social\/v1\/relationships\/(s_[a-f0-9]{32})\/([a-z]+)$/.exec(path);
      if (relationship) applyRelationship(relationship[1], relationship[2]);
      else if (path === '/api/social/v1/me/deactivate') {
        // Deactivation hides the profile and removes friendships and requests, keeping private blocks.
        profile = { ...profile, active: false, discoverable: false, revision: profile.revision + 1 };
        lists = { friends: [], incoming: [], outgoing: [], blocks: lists.blocks };
      } else if (path === '/api/social/v1/me/profile') {
        profile = { ...profile, alias: body.alias, discoverable: body.discoverable, active: true, revision: profile.revision + 1 };
      } else throw new Error(`Unhandled synthetic mutation ${path}`);
      return response({ commandId: body.commandId, outcome: 'applied', replayed: false });
    }
    if (path === '/api/social/v1/me/profile') return response({ profile });
    if (path.startsWith('/api/social/v1/relationships?')) {
      const kind = new URLSearchParams(path.slice(path.indexOf('?'))).get('kind') as SocialListKind;
      return response({ items: lists[kind], nextCursor: null });
    }
    throw new Error(`Unhandled synthetic request ${path}`);
  }));
});

const show = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(browserSessionQueryKey, { user: { id: 'viewer-1', email: 'private@example.invalid' } });
  return render(<QueryClientProvider client={client}><MemoryRouter><SocialPage /></MemoryRouter></QueryClientProvider>);
};
/** The relationship lists, apart from friend listening status, which can name the same people. */
const relationships = async () => (await screen.findByRole('tablist', { name: 'Friends' })).closest('section')!;
const listed = async (alias: string) => (await within(await relationships()).findByText(alias)).closest('li')!;
const emptyList = async () => expect(await within(await relationships()).findByText('Nothing here yet.')).toBeInTheDocument();

/**
 * Clicks a Remove, Block or Deactivate control and answers a confirmation if one is asked, whether through the
 * browser's confirm or an in-page dialog whose confirming button repeats the action's name. Whether an action must
 * ask first has its own tests; these flows assert what the answered action sends.
 */
const perform = async (button: HTMLElement, accept = true) => {
  const name = button.textContent!;
  const [requests, prompts] = [sent.length, nativeConfirm.mock.calls.length];
  nativeConfirm.mockReturnValue(accept);
  fireEvent.click(button);
  await waitFor(() => expect(sent.length > requests || nativeConfirm.mock.calls.length > prompts
    || screen.queryByRole('dialog') !== null).toBe(true));
  const dialog = screen.queryByRole('dialog');
  if (dialog) fireEvent.click(within(dialog).getByRole('button', { name: accept ? name : 'Cancel' }));
};

test('removing a friend sends the observed revision and the refreshed list no longer shows them', async () => {
  lists.friends = [row(bob, 5), row(carol, 6)]; show();
  await perform(within(await listed('Bob')).getByRole('button', { name: 'Remove friend' }));
  await waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0]).toEqual({ path: `/api/social/v1/relationships/${bob.socialId}/remove`,
    body: { expectedRevision: 5, scopeToken, commandId: expect.any(String) } });
  expect(await screen.findByText('Updated.')).toBeInTheDocument();
  const list = await relationships();
  await waitFor(() => expect(within(list).queryByText('Bob')).not.toBeInTheDocument());
  expect(within(list).getByText('Carol')).toBeInTheDocument();
});

test('blocking clears the relationship, the Blocked tab shows only an opaque identity, and unblocking restores nothing', async () => {
  lists.friends = [row(bob, 5)]; show();
  await perform(within(await listed('Bob')).getByRole('button', { name: 'Block' }));
  await waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0].path).toBe(`/api/social/v1/relationships/${bob.socialId}/block`);
  // A block applies to the pair whatever its state, so it carries no observed revision.
  expect(sent[0].body).not.toHaveProperty('expectedRevision');
  await emptyList();

  fireEvent.click(screen.getByRole('tab', { name: 'Blocked' }));
  const blocked = await listed('Blocked profile');
  // The private block list never unlocks the blocked person's current profile.
  expect(blocked).toHaveTextContent(bob.socialId.slice(-8));
  expect(blocked).not.toHaveTextContent('Bob'); expect(blocked).not.toHaveTextContent('@bobby');
  expect(within(blocked).queryByRole('button', { name: 'Block' })).not.toBeInTheDocument();
  fireEvent.click(within(blocked).getByRole('button', { name: 'Unblock' }));
  await waitFor(() => expect(sent).toHaveLength(2));
  expect(sent[1]).toMatchObject({ path: `/api/social/v1/relationships/${bob.socialId}/unblock`, body: { expectedRevision: 11 } });
  await emptyList();

  fireEvent.click(screen.getByRole('tab', { name: 'Friends' }));
  await emptyList();
  expect(sent).toHaveLength(2);
});

test('a sent request is cancelled and an incoming one declined, each against its observed revision', async () => {
  lists.outgoing = [row(carol, 2)]; lists.incoming = [row(bob, 4)]; show();
  fireEvent.click(await screen.findByRole('tab', { name: 'Sent requests' }));
  fireEvent.click(within(await listed('Carol')).getByRole('button', { name: 'Cancel request' }));
  await waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0]).toMatchObject({ path: `/api/social/v1/relationships/${carol.socialId}/cancel`, body: { expectedRevision: 2 } });
  await emptyList();

  fireEvent.click(screen.getByRole('tab', { name: 'Incoming requests' }));
  fireEvent.click(within(await listed('Bob')).getByRole('button', { name: 'Decline' }));
  await waitFor(() => expect(sent).toHaveLength(2));
  expect(sent[1]).toMatchObject({ path: `/api/social/v1/relationships/${bob.socialId}/decline`, body: { expectedRevision: 4 } });
  await emptyList();
  // Both are single explicit actions that are easily redone.
  expect(nativeConfirm).not.toHaveBeenCalled();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('cancelling a request that was accepted meanwhile reports the change, shows the latest state and is not resent', async () => {
  lists.outgoing = [row(carol, 2)]; show();
  fireEvent.click(await screen.findByRole('tab', { name: 'Sent requests' }));
  const request = await listed('Carol');
  // Carol accepts before the cancellation arrives, so the server refuses it against the older revision.
  lists = { ...lists, outgoing: [], friends: [row(carol, 3)] };
  refusals[`/api/social/v1/relationships/${carol.socialId}/cancel`] = 'relationship_changed';
  fireEvent.click(within(request).getByRole('button', { name: 'Cancel request' }));
  expect(await screen.findByText('This changed while you were acting. The latest state is now shown.')).toBeInTheDocument();
  await emptyList();
  // A definite refusal keeps nothing for an outcome lookup or a resend.
  expect(screen.queryByRole('button', { name: 'Check outcome' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('tab', { name: 'Friends' }));
  expect(within(await listed('Carol')).getByRole('button', { name: 'Remove friend' })).toBeEnabled();
  expect(sent).toHaveLength(1);
});

test('deactivation runs only once confirmed and leaves an inactive profile that offers reactivation', async () => {
  lists.friends = [row(bob, 5)]; const stop = vi.spyOn(roomSession, 'stop'); show();
  expect(await screen.findByRole('region', { name: 'Listening room' })).toBeInTheDocument();
  await perform(await screen.findByRole('button', { name: 'Deactivate social profile' }), false);
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(sent).toEqual([]);
  expect(screen.getByRole('button', { name: 'Save profile' })).toBeInTheDocument();
  expect(await listed('Bob')).toBeInTheDocument();

  await perform(screen.getByRole('button', { name: 'Deactivate social profile' }));
  await waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0].path).toBe('/api/social/v1/me/deactivate');
  expect(Object.keys(sent[0].body).sort()).toEqual(['commandId', 'scopeToken']);
  expect(await screen.findByText('Your social profile is inactive.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Reactivate profile' })).toBeEnabled();
  expect(screen.queryByRole('button', { name: 'Deactivate social profile' })).not.toBeInTheDocument();
  // An inactive identity leaves its room and cannot look anyone up.
  expect(screen.queryByRole('region', { name: 'Listening room' })).not.toBeInTheDocument();
  await waitFor(() => expect(stop).toHaveBeenCalled());
  expect(within(screen.getByRole('form', { name: 'Find a friend' })).getByLabelText('Handle')).toBeDisabled();
  await emptyList();
});

test('reactivation saves against the inactive revision and restores the social surface but no relationship', async () => {
  profile = { ...own, active: false, discoverable: false, revision: 3 }; show();
  expect(await screen.findByText('Your social profile is inactive.')).toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'Listening room' })).not.toBeInTheDocument();
  const form = screen.getByRole('form', { name: 'Your social profile' });
  // Deactivation turned discovery off; the handle becomes findable again only by explicit choice.
  const discoverable = within(form).getByRole('checkbox', { name: 'Let others find me by my exact handle' });
  expect(discoverable).not.toBeChecked();
  fireEvent.click(discoverable);
  expect(within(form).getByRole('button', { name: 'Reactivate profile' })).toBeEnabled();
  fireEvent.submit(form);
  await waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0]).toMatchObject({ path: '/api/social/v1/me/profile',
    body: { expectedRevision: 3, handle: 'alice', alias: 'Alice', discoverable: true, scopeToken } });
  expect(await screen.findByRole('button', { name: 'Save profile' })).toBeInTheDocument();
  expect(screen.queryByText('Your social profile is inactive.')).not.toBeInTheDocument();
  expect(await screen.findByRole('region', { name: 'Listening room' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Deactivate social profile' })).toBeEnabled();
  await emptyList();
});
