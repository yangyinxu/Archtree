import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SaveButton } from './SaveButton';

vi.mock('../api/saveCache', () => { throw new TypeError('Failed to fetch dynamically imported module'); });

test.each([false, true])('does not dispatch a saved=%s mutation when its reconciliation chunk cannot load', async (saved) => {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  const onSavedChange = vi.fn();
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><SaveButton viewerId="viewer-1" saved={saved}
    target={{ contentType: 'album', contentId: 'album-1' }} onSavedChange={onSavedChange} /></QueryClientProvider>);

  await userEvent.setup().click(screen.getByRole('button'));
  await screen.findByRole('alert');
  expect(fetchMock).not.toHaveBeenCalled();
  expect(onSavedChange).not.toHaveBeenCalled();
});
