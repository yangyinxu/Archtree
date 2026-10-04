import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import { roomFixture } from '../../test/roomFixture';
import type { RoomSnapshot } from '../../api/rooms';
import { RoomsPanel } from './RoomsPanel';

/** A countdown chunk that cannot load, for example a stale hash requested right after a deploy. */
vi.mock('./RoomDeadline', () => { throw new Error('Failed to fetch dynamically imported module'); });
const mocks = vi.hoisted(() => ({ room: null as RoomSnapshot | null }));
vi.mock('./roomSession', () => ({ roomSession: { run: vi.fn(), control: vi.fn(), ensure: vi.fn() },
  useRoomSession: () => ({ viewerId: 'viewer-1', room: mocks.room, connected: true, locallyPaused: false, busy: false,
    error: null, uncertain: null, roomReceivedAtMs: 0 }) }));
vi.mock('./RoomSongRequests', () => ({ RoomSongRequests: () => null }));
vi.mock('../../player', () => ({ usePlayer: () => ({ currentItem: null, currentTime: 0, error: null }) }));
vi.mock('../../api/rooms', async original => ({ ...await original<typeof import('../../api/rooms')>(),
  getRoomInvitations: async () => ({ invitations: [] }),
  getRoomCapabilities: async () => ({ socialEnabled: true, roomsEnabled: true }),
  getOutgoingRoomInvitations: async () => ({ invitations: [] }) }));
vi.mock('../../api/social', () => ({ getSocialPage: async () => ({ items: [], nextCursor: null }) }));

const show = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const content = () => <QueryClientProvider client={client}><RoomsPanel viewerId="viewer-1" profile={{
    ...roomFixture().members[0], active: true, discoverable: true, revision: 1 }} /></QueryClientProvider>;
  const rendered = render(content());
  return () => rendered.rerender(content());
};

test('a deadline chunk that fails to load keeps the countdown-free room status instead of throwing', async () => {
  const fixture = roomFixture();
  mocks.room = { ...fixture, status: 'suspended', hostMemberId: 'other-member', hostAbsenceDeadlineMs: fixture.serverTimeMs,
    members: [...fixture.members, { ...fixture.members[0], memberId: 'other-member', role: 'host', connected: false }] };
  const rerender = show();
  // The rejected chunk resolves to the loading fallback's own status line, with no timer, and the panel stays usable.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(screen.getByText('Shared playback is suspended until the host starts it again.')).toBeVisible();
  expect(screen.queryByRole('timer')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Leave room' })).toBeEnabled();
  mocks.room = { ...mocks.room, status: 'ended' }; rerender();
  expect(screen.getByText('This room has ended.')).toBeVisible();
});
