import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { roomFixture } from '../../test/roomFixture';
import { GlobalActiveRoom } from './GlobalActiveRoom';

const mocks = vi.hoisted(() => ({ state: vi.fn() }));
vi.mock('./roomSession', () => ({ useRoomSession: mocks.state }));

test('room entry describes shared playback and returns to controls without performing an action', () => {
  const room = roomFixture();
  room.timeline!.state = 'paused';
  mocks.state.mockReturnValue({ viewerId: 'viewer-a', room, connected: true, locallyPaused: false });
  render(<MemoryRouter><GlobalActiveRoom viewerId="viewer-a" /></MemoryRouter>);
  expect(screen.getByRole('link', { name: 'Open room: Room paused' })).toHaveAttribute('href', '/social');
});

test.each([
  [{ connected: false }, 'Room reconnecting'],
  [{ locallyPaused: true }, 'Room paused on this device'],
  [{ uncertain: { action: 'requestSong' } }, 'Room action needs attention'],
  [{ room: { ...roomFixture(), status: 'suspended' } }, 'Room suspended'],
  [{ room: { ...roomFixture(), self: { ...roomFixture().self, isController: false } } }, 'Observing room'],
  [{ room: { ...roomFixture(), timeline: { ...roomFixture().timeline, state: 'playing' } } }, 'Room playing'],
  [{ room: { ...roomFixture(), timeline: { ...roomFixture().timeline, state: 'preparing' } } }, 'Room preparing']
])('distinguishes room status %j', (change, label) => {
  mocks.state.mockReturnValue({ viewerId: 'viewer-a', room: roomFixture(), connected: true, locallyPaused: false, ...change });
  render(<MemoryRouter><GlobalActiveRoom viewerId="viewer-a" /></MemoryRouter>);
  expect(screen.getByRole('link', { name: `Open room: ${label}` })).toBeVisible();
});

test('retains a recovery entry when creation is uncertain without exposing another account', () => {
  mocks.state.mockReturnValue({ viewerId: 'viewer-a', room: null, uncertain: { action: 'create' } });
  const view = render(<MemoryRouter><GlobalActiveRoom viewerId="viewer-a" /></MemoryRouter>);
  expect(screen.getByRole('link', { name: 'Open room: Room action needs attention' })).toBeVisible();
  view.rerender(<MemoryRouter><GlobalActiveRoom viewerId="viewer-b" /></MemoryRouter>);
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
});

test.each([null, { ...roomFixture(), status: 'ended' }])('clears an unavailable room entry', room => {
  mocks.state.mockReturnValue({ viewerId: 'viewer-a', room });
  render(<MemoryRouter><GlobalActiveRoom viewerId="viewer-a" /></MemoryRouter>);
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
});
