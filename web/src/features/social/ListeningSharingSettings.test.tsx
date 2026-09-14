import { fireEvent, render, screen } from '@testing-library/react';
import { ListeningSharingSettings } from './ListeningSharingSettings';
const mocks = vi.hoisted(() => ({ state: { viewerId: 'alice', own: null as any, busy: false, error: null as any, uncertain: null as any, owned: false, publishing: false },
  setEnabled: vi.fn(), useDevice: vi.fn(), check: vi.fn(), retry: vi.fn(), refresh: vi.fn() }));
vi.mock('./listeningSession', () => ({ useListeningSession: () => mocks.state, listeningSession: mocks }));
beforeEach(() => { vi.clearAllMocks(); mocks.state = { viewerId: 'alice', own: { enabled: false, revision: 0, publisherRevision: 0, serverTimeMs: 1 }, busy: false, error: null, uncertain: null, owned: false, publishing: false }; });
test('default off requires explicit opt-in; mounting performs no preference or playback action', () => {
  render(<ListeningSharingSettings viewerId="alice" />);
  expect(mocks.setEnabled).not.toHaveBeenCalled(); expect(mocks.useDevice).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Enable listening sharing' })); expect(mocks.setEnabled).toHaveBeenCalledExactlyOnceWith(true);
  expect(screen.queryByRole('button', { name: 'Share from this device' })).not.toBeInTheDocument();
});
test('unknown opt-out keeps durable enabled copy and receipt recovery while allowing local stop', () => {
  mocks.state.own.enabled = true; mocks.state.uncertain = { action: 'setListeningSharing', enabled: false }; mocks.state.error = 'social.unknown';
  render(<ListeningSharingSettings viewerId="alice" />);
  expect(screen.queryByRole('button', { name: 'Enable listening sharing' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Share from this device' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Turn off listening sharing' })); expect(mocks.setEnabled).toHaveBeenCalledWith(false);
  fireEvent.click(screen.getByRole('button', { name: 'Check outcome' })); expect(mocks.check).toHaveBeenCalledTimes(1);
});
test('another account cannot display or act on retained publisher state', () => {
  render(<ListeningSharingSettings viewerId="bob" />);
  expect(screen.queryByRole('button', { name: 'Enable listening sharing' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Share from this device' })).not.toBeInTheDocument();
});
