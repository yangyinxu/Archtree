import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { advanceAccountEpoch } from '../api/accountEpoch';
import { SaveButton } from './SaveButton';

const chunk = vi.hoisted(() => {
  let resolve!: () => void;
  return { ready: new Promise<void>((done) => { resolve = done; }), release: () => resolve(), requested: vi.fn() };
});
vi.mock('../api/saveCache', async () => {
  chunk.requested();
  await chunk.ready;
  return { commitSaveStatus: vi.fn() };
});

test('an account transition while loading the reconciliation chunk cancels the undispatched Save', async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  const onSavedChange = vi.fn();
  const client = new QueryClient();
  render(<QueryClientProvider client={client}><SaveButton viewerId="viewer-1" saved={false}
    target={{ contentType: 'album', contentId: 'album-1' }} onSavedChange={onSavedChange} /></QueryClientProvider>);

  await userEvent.setup().click(screen.getByRole('button'));
  await waitFor(() => expect(chunk.requested).toHaveBeenCalled());
  await act(async () => { advanceAccountEpoch(); chunk.release(); });
  await waitFor(() => expect(screen.getByRole('button')).toHaveAttribute('aria-disabled', 'false'));
  expect(fetchMock).not.toHaveBeenCalled();
  expect(onSavedChange).not.toHaveBeenCalled();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
