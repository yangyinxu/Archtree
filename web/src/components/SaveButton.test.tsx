import type { ComponentProps } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SaveButton } from './SaveButton';

const target = {
  contentType: 'album' as const,
  contentId: '64b000000000000000000001'
};

const renderButton = (props: Partial<ComponentProps<typeof SaveButton>> = {}) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <SaveButton saved={false} target={target} {...props} />
    </QueryClientProvider>
  );
};

test('signed-out Save remains clickable only to explain the login requirement', async () => {
  const user = userEvent.setup();
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  renderButton();

  await user.click(screen.getByRole('button', { name: 'Save to Library' }));

  expect(screen.getByRole('alert')).toHaveTextContent('Log in to save');
  expect(fetchMock).not.toHaveBeenCalled();
});

test('Save changes authoritative state only after the server confirms it', async () => {
  const user = userEvent.setup();
  const onSavedChange = vi.fn();
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
    ...target,
    saved: true
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  renderButton({ viewerId: 'listener-1', onSavedChange });

  await user.click(screen.getByRole('button', { name: 'Save to Library' }));

  await waitFor(() => expect(onSavedChange).toHaveBeenCalledWith(true));
  expect(fetchMock).toHaveBeenCalledWith(
    `/content/me/saves/album/${target.contentId}`,
    expect.objectContaining({ method: 'PUT' })
  );
});
