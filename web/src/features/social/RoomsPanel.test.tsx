import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { roomFixture } from '../../test/roomFixture';
import type { RoomSnapshot } from '../../api/rooms';
import { RoomsPanel } from './RoomsPanel';

const mocks = vi.hoisted(() => ({ room: null as RoomSnapshot | null, run: vi.fn(), control: vi.fn(), ensure: vi.fn() }));
vi.mock('./roomSession', () => ({ roomSession: { run: mocks.run, control: mocks.control, ensure: mocks.ensure },
  useRoomSession: () => ({ viewerId: 'viewer-1', room: mocks.room, connected: true, locallyPaused: false, busy: false, error: null, uncertain: null }) }));
vi.mock('../../player', () => ({ usePlayer: () => ({ currentItem: null, currentTime: 0, error: null }) }));
vi.mock('../../api/rooms', async original => ({ ...await original<typeof import('../../api/rooms')>(),
  getRoomInvitations: async () => ({ invitations: [] }), getRoomMedia: async () => ({ items: [] }) }));
vi.mock('../../api/social', () => ({ getSocialPage: async () => ({ items: [], nextCursor: null }) }));

const show = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const content = () => <QueryClientProvider client={client}><RoomsPanel viewerId="viewer-1" profile={{
    ...mocks.room!.members[0], active: true, discoverable: true, revision: 1
  }} /></QueryClientProvider>;
  const rendered = render(content());
  return () => rendered.rerender(content());
};
beforeEach(() => { mocks.room = roomFixture(); vi.clearAllMocks(); });

test('dragging the seek bar retains the playback precondition seen at gesture start', () => {
  const rerender = show();
  const slider = screen.getByRole('slider', { name: 'Room playback position' });
  fireEvent.pointerDown(slider);
  mocks.room = { ...mocks.room!, revision: 2, timeline: { ...mocks.room!.timeline!, playbackGeneration: 2 } };
  rerender();
  fireEvent.change(slider, { target: { value: '10' } }); fireEvent.pointerUp(slider);
  expect(mocks.run).toHaveBeenCalledWith(expect.objectContaining({ action: 'seek', positionMs: 10_000, expectedPlaybackGeneration: 1 }));
  expect(mocks.control).not.toHaveBeenCalled();
});

test('a suspended room allows its returning host to resume and keeps guest controls disabled', () => {
  mocks.room = { ...mocks.room!, status: 'suspended', controlMode: 'everyone', hostMemberId: 'other-member' };
  const rerender = show();
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  mocks.room = { ...mocks.room!, hostMemberId: mocks.room!.self.memberId }; rerender();
  expect(screen.getByRole('button', { name: 'Play for everyone' })).toBeEnabled();
  expect(screen.getByRole('combobox', { name: 'Playback control' })).toBeDisabled();
});
