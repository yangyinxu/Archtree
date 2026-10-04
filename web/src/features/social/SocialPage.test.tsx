import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
let friendsListed = false;
let lastCommandId = '';
/** Relationship reads that fail before the synthetic server answers again. */
let relationshipFailures = 0;
/** Mutation paths the synthetic server refuses with a recorded outcome code. */
let refusals: Record<string, string> = {};
const response = (body: unknown) => new Response(JSON.stringify(body), { headers: {
  'Content-Type': 'application/json', 'X-Finitude-Account-Viewer': 'viewer-1'
} });
beforeEach(() => {
  advanceAccountEpoch(); current = null; mutations = []; unknown = false; profileUnavailable = false; admissionDisabled = false; lastCommandId = '';
  friendsListed = false; relationshipFailures = 0;
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
    if (path.startsWith('/api/social/v1/relationships?')) return response({ items: path.includes('kind=incoming') ? [{ socialId: peer.socialId, profile: peer, revision: 4 }]
      : friendsListed && path.includes('kind=friends') ? [{ socialId: peer.socialId, profile: peer, revision: 5 }] : [], nextCursor: null });
    if (path.startsWith('/api/social/v1/profiles?')) return response({ profile: path.includes('handle=alice')
      ? { socialId: own.socialId, handle: own.handle, alias: own.alias, iconSeed: own.iconSeed } : peer });
    if (path === `/api/social/v1/relationships/${peer.socialId}`) {
      if (relationshipFailures > 0) { relationshipFailures--; return new Response(JSON.stringify({ code: 'unavailable' }), { status: 503 }); }
      return response({ relationship: { socialId: peer.socialId, state: 'none', revision: 3 } });
    }
    // The relationship read has no state for the viewer's own profile.
    if (path === `/api/social/v1/relationships/${own.socialId}`) return response({ relationship: null });
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
  // Signing in returns here, like every other social entry point.
  expect(screen.getByRole('link', { name: 'Log in' })).toHaveAttribute('href', '/login?returnTo=%2Fsocial');
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
  // An inactive profile stops the room session through a dynamic import; let it finish before teardown.
  await vi.dynamicImportSettled();
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

test('removing a friend asks first: Cancel keeps the friendship and returns focus, confirming sends the observed revision', async () => {
  current = own; friendsListed = true; const user = userEvent.setup(); show();
  const remove = await screen.findByRole('button', { name: 'Remove friend' });
  await user.click(remove);
  const dialog = await screen.findByRole('dialog', { name: 'Remove Bob from your friends?' });
  expect(dialog).toHaveAccessibleDescription(/You and Bob stop seeing each other’s listening status/);
  const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
  await waitFor(() => expect(cancel).toHaveFocus());
  await user.click(cancel);
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(remove).toHaveFocus(); expect(mutations).toEqual([]);
  await user.click(remove);
  await user.click(within(await screen.findByRole('dialog', { name: 'Remove Bob from your friends?' })).getByRole('button', { name: 'Remove friend' }));
  await waitFor(() => expect(mutations).toHaveLength(1));
  expect(mutations[0]).toMatchObject({ path: `/api/social/v1/relationships/${peer.socialId}/remove`, body: { expectedRevision: 5 } });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('blocking from a request list asks first and Escape cancels, while Decline stays a single explicit action', async () => {
  current = own; show();
  fireEvent.click(await screen.findByRole('tab', { name: 'Incoming requests' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Block' }));
  const dialog = await screen.findByRole('dialog', { name: 'Block Bob?' });
  expect(dialog).toHaveAccessibleDescription(/Unblocking later does not restore the friendship/);
  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(mutations).toEqual([]);
  fireEvent.click(screen.getByRole('button', { name: 'Block' }));
  fireEvent.click(within(await screen.findByRole('dialog', { name: 'Block Bob?' })).getByRole('button', { name: 'Block' }));
  await waitFor(() => expect(mutations).toHaveLength(1));
  expect(mutations[0].path).toBe(`/api/social/v1/relationships/${peer.socialId}/block`);
  expect(mutations[0].body).not.toHaveProperty('expectedRevision');
  fireEvent.click(await screen.findByRole('button', { name: 'Decline' }));
  await waitFor(() => expect(mutations).toHaveLength(2));
  expect(mutations[1]).toMatchObject({ path: `/api/social/v1/relationships/${peer.socialId}/decline`, body: { expectedRevision: 4 } });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('someone found by handle can be blocked with no relationship, and the own profile offers no Block', async () => {
  current = own; show();
  const form = await screen.findByRole('form', { name: 'Find a friend' });
  fireEvent.change(within(form).getByLabelText('Handle'), { target: { value: 'bobby' } });
  fireEvent.submit(form);
  await screen.findByRole('button', { name: 'Add friend' });
  const lookup = screen.getByRole('form', { name: 'Find a friend' }).closest('section')!;
  fireEvent.click(within(lookup).getByRole('button', { name: 'Block' }));
  fireEvent.click(within(await screen.findByRole('dialog', { name: 'Block Bob?' })).getByRole('button', { name: 'Block' }));
  await waitFor(() => expect(mutations).toHaveLength(1));
  expect(mutations[0].path).toBe(`/api/social/v1/relationships/${peer.socialId}/block`);
  expect(await screen.findByText('Updated.')).toHaveAttribute('role', 'status');
  fireEvent.change(within(form).getByLabelText('Handle'), { target: { value: 'alice' } });
  fireEvent.submit(form);
  expect(await within(lookup).findByText('@alice')).toBeInTheDocument();
  await waitFor(() => expect(fetch).toHaveBeenCalledWith(`/api/social/v1/relationships/${own.socialId}`, expect.anything()));
  expect(within(lookup).queryByRole('button', { name: 'Block' })).not.toBeInTheDocument();
  expect(within(lookup).queryByRole('button', { name: 'Add friend' })).not.toBeInTheDocument();
});

test('relationship tabs follow the tabs pattern: each tab controls its labelled panel and arrows, Home and End move selection', async () => {
  current = own; friendsListed = true; const user = userEvent.setup(); show();
  const friends = await screen.findByRole('tab', { name: 'Friends' });
  const incoming = screen.getByRole('tab', { name: 'Incoming requests' });
  const blocked = screen.getByRole('tab', { name: 'Blocked' });
  // Only the selected tab is in the Tab order, and every tab names a panel that exists.
  expect(screen.getAllByRole('tab').map(tab => tab.tabIndex)).toEqual([0, -1, -1, -1]);
  for (const tab of screen.getAllByRole('tab')) expect(document.getElementById(tab.getAttribute('aria-controls')!)).toHaveAttribute('role', 'tabpanel');
  const friendsPanel = screen.getByRole('tabpanel', { name: 'Friends' });
  expect(friendsPanel).toHaveAttribute('id', friends.getAttribute('aria-controls'));
  expect(await within(friendsPanel).findByText('Bob')).toBeInTheDocument();
  expect(screen.getAllByRole('tabpanel')).toHaveLength(1);

  friends.focus();
  await user.keyboard('{ArrowRight}');
  expect(incoming).toHaveFocus(); expect(incoming).toHaveAttribute('aria-selected', 'true'); expect(incoming.tabIndex).toBe(0);
  expect(friends).toHaveAttribute('aria-selected', 'false'); expect(friends.tabIndex).toBe(-1);
  expect(await within(screen.getByRole('tabpanel', { name: 'Incoming requests' })).findByRole('button', { name: 'Accept' })).toBeInTheDocument();
  await user.keyboard('{End}');
  expect(blocked).toHaveFocus(); expect(blocked).toHaveAttribute('aria-selected', 'true');
  await user.keyboard('{ArrowRight}');
  expect(friends).toHaveFocus();
  await user.keyboard('{ArrowLeft}');
  expect(blocked).toHaveFocus();
  await user.keyboard('{Home}');
  expect(friends).toHaveFocus(); expect(friends).toHaveAttribute('aria-selected', 'true');
  // Other keys keep their default behavior: Tab leaves the tab list for the selected panel.
  await user.keyboard('{Tab}');
  expect(screen.getByRole('tabpanel', { name: 'Friends' })).toHaveFocus();
  expect(mutations).toEqual([]);
});

test('modified arrow keys stay browser shortcuts, so Alt+ArrowLeft (Back) neither moves nor is swallowed', async () => {
  current = own; show();
  const friends = await screen.findByRole('tab', { name: 'Friends' });
  friends.focus();
  // fireEvent returns false only when a handler prevented the default action.
  for (const modifier of [{ altKey: true }, { ctrlKey: true }, { metaKey: true }]) {
    expect(fireEvent.keyDown(friends, { key: 'ArrowLeft', ...modifier })).toBe(true);
    expect(fireEvent.keyDown(friends, { key: 'ArrowRight', ...modifier })).toBe(true);
    expect(friends).toHaveFocus(); expect(friends).toHaveAttribute('aria-selected', 'true');
  }
  // The unmodified key still moves within the tab list.
  expect(fireEvent.keyDown(friends, { key: 'ArrowLeft' })).toBe(false);
  expect(screen.getByRole('tab', { name: 'Blocked' })).toHaveAttribute('aria-selected', 'true');
});

test('a failed relationship read after a lookup is announced with Retry instead of silently offering no action', async () => {
  current = own; relationshipFailures = 1; show();
  const form = await screen.findByRole('form', { name: 'Find a friend' });
  fireEvent.change(within(form).getByLabelText('Handle'), { target: { value: 'bobby' } });
  fireEvent.submit(form);
  const lookup = form.closest('section')!;
  const alert = await within(lookup).findByRole('alert');
  expect(alert).toHaveTextContent('We couldn’t check your connection with this person. Try again.');
  expect(within(lookup).queryByRole('button', { name: 'Add friend' })).not.toBeInTheDocument();
  expect(within(lookup).queryByRole('button', { name: 'Block' })).not.toBeInTheDocument();
  fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
  expect(await within(lookup).findByRole('button', { name: 'Add friend' })).toBeEnabled();
  expect(within(lookup).queryByRole('alert')).not.toBeInTheDocument();
  expect(mutations).toEqual([]);
});

test('deactivating asks in the accessible dialog, says what is removed and kept, and Cancel sends nothing', async () => {
  current = own; const user = userEvent.setup(); const nativeConfirm = vi.spyOn(window, 'confirm'); show();
  const deactivate = await screen.findByRole('button', { name: 'Deactivate social profile' });
  await user.click(deactivate);
  const dialog = await screen.findByRole('dialog', { name: 'Deactivate your social profile?' });
  expect(dialog).toHaveAccessibleDescription(/friendships, shared music and listening status sharing are removed.*Your handle and blocks are kept/);
  await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus());
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(deactivate).toHaveFocus(); expect(mutations).toEqual([]);
  await user.click(deactivate);
  await user.click(within(await screen.findByRole('dialog', { name: 'Deactivate your social profile?' })).getByRole('button', { name: 'Deactivate social profile' }));
  await waitFor(() => expect(mutations).toHaveLength(1));
  expect(mutations[0].path).toBe('/api/social/v1/me/deactivate');
  expect(nativeConfirm).not.toHaveBeenCalled();
  nativeConfirm.mockRestore();
});

test('setup describes the handle format and counts the display name in characters, as the server does', async () => {
  show();
  const form = await screen.findByRole('form', { name: 'Your social profile' });
  const handle = within(form).getByLabelText('Handle');
  const alias = within(form).getByLabelText('Display name') as HTMLInputElement;
  expect(handle).toHaveAccessibleDescription('3–24 letters, numbers or underscores, starting with a letter.');
  expect(alias).toHaveAccessibleDescription('Up to 50 characters. Friends see this name.');
  fireEvent.change(handle, { target: { value: 'alice' } });
  for (const [value, message] of [['A'.repeat(51), 'Use 1 to 50 characters.'], ['   ', 'Use 1 to 50 characters.'],
    ['Ali\u200dce', 'Remove invisible formatting characters. Some combined emoji include them.']]) {
    fireEvent.change(alias, { target: { value } });
    expect(alias.validationMessage).toBe(message);
    fireEvent.submit(form);
  }
  expect(mutations).toEqual([]);
  // Fifty emoji are 100 UTF-16 units but 50 characters, so the browser must not cut or refuse them.
  const emoji = '🎧'.repeat(50);
  fireEvent.change(alias, { target: { value: emoji } });
  expect(alias.validationMessage).toBe(''); expect(alias).not.toHaveAttribute('maxlength');
  fireEvent.submit(form);
  await waitFor(() => expect(mutations).toHaveLength(1));
  expect(mutations[0].body).toMatchObject({ handle: 'alice', alias: emoji });
  // A set handle cannot change, so the format hint goes away with the editable field.
  const saved = within(await screen.findByRole('form', { name: 'Your social profile' })).getByLabelText('Handle');
  await waitFor(() => expect(saved).toBeDisabled());
  expect(saved).not.toHaveAccessibleDescription();
});
