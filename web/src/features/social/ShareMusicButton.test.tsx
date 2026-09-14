import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { browserSessionQueryKey, browserSessionResolvingQueryKey } from '../../api/session';
import { advanceAccountEpoch } from '../../api/accountEpoch';
import type { AudioTrackSummary } from '../../api/contentSchemas';
import { ContentCard } from '../../components/ContentCard';
import { ContentListRow } from '../../components/ContentListRow';
import ShareMusicButton from './ShareMusicButton';
import { musicShareSession } from './musicShareSession';

const mocks = vi.hoisted(() => ({ profile: vi.fn(), friends: vi.fn(), prepare: vi.fn(), send: vi.fn(), outcome: vi.fn() }));
vi.mock('../../api/social', async original => ({ ...await original<typeof import('../../api/social')>(), getSocialProfile: mocks.profile,
  getSocialPage: mocks.friends, prepareSocialCommand: mocks.prepare, sendSocialCommand: mocks.send, getSocialOutcome: mocks.outcome }));
const friend = { socialId: `s_${'b'.repeat(32)}`, revision: 17, profile: { socialId: `s_${'b'.repeat(32)}`, handle: 'bobby', alias: 'Bob', iconSeed: 'bob' } };
const profile = { socialId: `s_${'a'.repeat(32)}`, handle: 'alice', alias: 'Alice', iconSeed: 'alice', active: true, discoverable: true, revision: 1 };
const track: AudioTrackSummary = { contentType: 'audioTrack', id: 'a'.repeat(24), title: 'Quiet track', artworkUrl: '', artistNames: [], albumId: null,
  albumTitle: null, duration: null, mediaType: 'audio', streamUrl: '/content/mediaTrack/stream/track-a' };
const show = (viewer: string | null = 'viewer-1', content = <ShareMusicButton contentType="audioTrack" contentId={track.id} title={track.title} />) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(browserSessionQueryKey, viewer ? { user: { id: viewer, email: 'private@example.test' } } : null);
  client.setQueryData(browserSessionResolvingQueryKey, false);
  return { client, ...render(<QueryClientProvider client={client}><MemoryRouter><Routes>
    <Route path="/" element={content} /><Route path="/social/shares" element={<h1>Inbox destination</h1>} />
  </Routes></MemoryRouter></QueryClientProvider>) };
};
const open = async () => {
  fireEvent.click(await screen.findByRole('button', { name: 'Share Quiet track' }));
  return screen.findByRole('dialog', { name: 'Share Quiet track' });
};
const selectFriend = async () => {
  const picker = await screen.findByRole('combobox', { name: 'Choose a friend' });
  await waitFor(() => expect(picker).toBeEnabled()); fireEvent.change(picker, { target: { value: friend.socialId } });
};
beforeEach(() => {
  advanceAccountEpoch(); vi.clearAllMocks(); mocks.profile.mockResolvedValue({ profile }); mocks.friends.mockResolvedValue({ items: [friend], nextCursor: null });
  mocks.prepare.mockImplementation(async (_viewer, action) => Object.freeze({ ...action, scopeToken: 'original-scope-token', commandId: 'original-command-01' }));
  mocks.send.mockResolvedValue({ commandId: 'original-command-01', outcome: 'applied', replayed: false }); mocks.outcome.mockResolvedValue({ outcome: null });
});
afterEach(() => { cleanup(); musicShareSession.stop(); });

test('catalog Share only opens auth-gated intent and signed-out users perform no private reads', async () => {
  show(null); expect(mocks.profile).not.toHaveBeenCalled(); const dialog = await open();
  expect(within(dialog).getByRole('link', { name: 'Log in' })).toHaveAttribute('href', '/login?returnTo=%2Fsocial%2Fshares');
  expect(mocks.profile).not.toHaveBeenCalled(); expect(mocks.friends).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled();
  fireEvent.keyDown(document, { key: 'Escape' }); expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('sharing sends only catalog identity, selected friend and observed friendship revision after explicit submission', async () => {
  show(); await open(); await selectFriend(); expect(mocks.send).not.toHaveBeenCalled();
  const submit = screen.getByRole('button', { name: 'Send share' });
  fireEvent.click(submit); fireEvent.click(submit);
  await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1));
  expect(mocks.prepare).toHaveBeenCalledExactlyOnceWith('viewer-1', { action: 'shareMusic', targetSocialId: friend.socialId,
    expectedRevision: 17, contentType: 'audioTrack', contentId: track.id });
  expect(mocks.send.mock.calls[0][1]).toEqual({ action: 'shareMusic', targetSocialId: friend.socialId, expectedRevision: 17,
    contentType: 'audioTrack', contentId: track.id, scopeToken: 'original-scope-token', commandId: 'original-command-01' });
  expect(screen.getByRole('dialog')).toBeVisible();
});

test('closing and reopening an uncertain share keeps original recovery and cannot create a fresh send', async () => {
  mocks.send.mockRejectedValueOnce(new TypeError('network disconnected')); show(); await open(); await selectFriend();
  fireEvent.click(screen.getByRole('button', { name: 'Send share' }));
  expect(await screen.findByRole('button', { name: 'Check outcome' })).toBeVisible();
  const original = mocks.send.mock.calls[0][1];
  fireEvent.click(screen.getByRole('button', { name: 'Close' })); await open();
  expect(screen.getByRole('button', { name: 'Send share' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Check outcome' }));
  await waitFor(() => expect(mocks.outcome).toHaveBeenCalledWith('viewer-1', original)); expect(mocks.send).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Retry this action' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Retry this action' }));
  await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(2)); expect(mocks.send.mock.calls[1][1]).toBe(original); expect(mocks.prepare).toHaveBeenCalledTimes(1);
});

test('account reconciliation removes cached friends and prevents old-account send', async () => {
  const { client } = show(); await open(); await selectFriend();
  await act(async () => { client.setQueryData(browserSessionResolvingQueryKey, true); });
  await waitFor(() => expect(screen.queryByRole('option', { name: 'Bob (@bobby)' })).not.toBeInTheDocument());
  expect(screen.queryByRole('button', { name: 'Send share' })).not.toBeInTheDocument();
  mocks.friends.mockResolvedValue({ items: [], nextCursor: null });
  await act(async () => { advanceAccountEpoch(); client.setQueryData(browserSessionQueryKey, { user: { id: 'viewer-2' } }); client.setQueryData(browserSessionResolvingQueryKey, false); });
  expect(await screen.findByText('Add a friend in Together to share music.')).toBeVisible();
  expect(screen.queryByRole('option', { name: 'Bob (@bobby)' })).not.toBeInTheDocument(); expect(mocks.send).not.toHaveBeenCalled();
});

test('a friendship refresh failure hides cached options and blocks submission', async () => {
  const { client } = show(); await open(); await selectFriend(); mocks.friends.mockRejectedValue(new Error('unavailable'));
  await act(async () => { await client.invalidateQueries({ queryKey: ['social', 'viewer-1', 'relationships', 'friends'] }); });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Send share' })).toBeDisabled());
  expect(screen.queryByRole('option', { name: 'Bob (@bobby)' })).not.toBeInTheDocument(); expect(mocks.send).not.toHaveBeenCalled();
});

test('dialog inbox navigation closes its portal and performs no send', async () => {
  show(); await open(); fireEvent.click(screen.getByRole('link', { name: 'Music shares' }));
  expect(await screen.findByRole('heading', { name: 'Inbox destination' })).toBeVisible(); expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(mocks.send).not.toHaveBeenCalled();
});

test.each(['card', 'row'])('the common %s share action is separate from primary playback', async kind => {
  const play = vi.fn(); show('viewer-1', kind === 'card' ? <ContentCard item={track} onPlay={play} /> : <ul><ContentListRow item={track} onPlay={play} /></ul>);
  const button = await screen.findByRole('button', { name: 'Share Quiet track' });
  expect(button.parentElement?.closest('button,a')).toBeNull(); fireEvent.click(button);
  expect(await screen.findByRole('dialog', { name: 'Share Quiet track' })).toBeVisible(); expect(play).not.toHaveBeenCalled();
});

test('unavailable library rows do not offer new sharing', () => {
  show('viewer-1', <ul><ContentListRow item={track} shareable={false} /></ul>);
  expect(screen.queryByRole('button', { name: 'Share Quiet track' })).not.toBeInTheDocument(); expect(mocks.profile).not.toHaveBeenCalled();
});
