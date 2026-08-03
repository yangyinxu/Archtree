import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';

import { privateAvatarQueryKey } from '../api/avatar';
import { Avatar } from './Avatar';

const renderAvatar = (node: React.ReactNode) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  });
  return render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
};

const imageResponse = (label: string) => new Response(new Blob([label], { type: 'image/jpeg' }), {
  status: 200,
  headers: { 'Content-Type': 'image/jpeg' }
});

beforeEach(() => {
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn()
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn()
  });
});

test('uses display-name initials, then email, then a neutral account icon', () => {
  const { rerender } = renderAvatar(<Avatar displayName="Yangyin Xu" email="listener@example.com" />);
  expect(screen.getByText('YX')).toBeInTheDocument();

  rerender(
    <QueryClientProvider client={new QueryClient()}>
      <Avatar email="listener@example.com" />
    </QueryClientProvider>
  );
  expect(screen.getByText('L')).toBeInTheDocument();

  rerender(
    <QueryClientProvider client={new QueryClient()}>
      <Avatar />
    </QueryClientProvider>
  );
  expect(document.querySelector('svg')).toBeInTheDocument();
});

test('falls back to initials when private image loading fails', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', {
    status: 404,
    headers: { 'Content-Type': 'application/json' }
  })));
  renderAvatar(
    <Avatar
      ariaLabel="Current profile photo"
      avatar={{ revision: 3 }}
      displayName="Listener Test"
      viewerId="listener-1"
    />
  );

  expect(screen.getByText('LT')).toBeInTheDocument();
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  expect(document.querySelector('img')).not.toBeInTheDocument();
});

test('gates the old object URL on the first render of an account switch', async () => {
  let resolveSecond!: (response: Response) => void;
  const second = new Promise<Response>((resolve) => { resolveSecond = resolve; });
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(imageResponse('first account'))
    .mockImplementationOnce(() => second);
  vi.stubGlobal('fetch', fetchMock);
  const createObjectURL = vi.mocked(URL.createObjectURL);
  createObjectURL.mockReturnValueOnce('blob:first-account').mockReturnValueOnce('blob:second-account');

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <Avatar avatar={{ revision: 1 }} displayName="First Account" viewerId="listener-1" />
    </QueryClientProvider>
  );
  await waitFor(() => expect(document.querySelector('img')).toHaveAttribute('src', 'blob:first-account'));

  view.rerender(
    <QueryClientProvider client={queryClient}>
      <Avatar avatar={{ revision: 4 }} displayName="Second Account" viewerId="listener-2" />
    </QueryClientProvider>
  );
  // The render gate runs before effects, preventing even a one-frame cross-account flash.
  expect(document.querySelector('img')).not.toBeInTheDocument();
  expect(screen.getByText('SA')).toBeInTheDocument();
  await waitFor(() => expect(
    queryClient.getQueryData(privateAvatarQueryKey('listener-1', 1))
  ).toBeUndefined());

  await act(async () => resolveSecond(imageResponse('second account')));
  await waitFor(() => expect(document.querySelector('img')).toHaveAttribute('src', 'blob:second-account'));
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:first-account');
});
