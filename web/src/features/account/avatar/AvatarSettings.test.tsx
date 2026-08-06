import { useRef, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { browserSessionQueryKey } from '../../../api/session';
import type { BrowserSession } from '../../../api/schemas';
import { AvatarCropDialog } from './AvatarCropDialog';
import { AvatarSettings, type AvatarAccountUser } from './AvatarSettings';

const listenerWithoutAvatar: AvatarAccountUser = {
  id: 'listener-1',
  displayName: 'Listener One',
  email: 'listener@example.com',
  avatarRevision: 0,
  avatar: null
};

const listenerWithAvatar: AvatarAccountUser = {
  ...listenerWithoutAvatar,
  avatarRevision: 3,
  avatar: { revision: 3 }
};

const sessionFor = (user: AvatarAccountUser): BrowserSession => ({
  user: {
    ...user,
    role: 'user',
    emailVerified: true
  }
});

const renderSettings = (user: AvatarAccountUser, onAvatarChange = vi.fn()) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(browserSessionQueryKey, sessionFor(user));
  const view = render(
    <QueryClientProvider client={queryClient}>
      <AvatarSettings onAvatarChange={onAvatarChange} user={user} />
    </QueryClientProvider>
  );
  return { ...view, onAvatarChange, queryClient };
};

let objectUrlCount = 0;

beforeEach(() => {
  objectUrlCount = 0;
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => `blob:avatar-${++objectUrlCount}`)
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn()
  });

  class TestImage {
    decoding = '';
    naturalHeight = 800;
    naturalWidth = 1200;
    onerror: (() => void) | null = null;
    onload: (() => void) | null = null;

    set src(_value: string) {
      queueMicrotask(() => this.onload?.());
    }
  }
  vi.stubGlobal('Image', TestImage);

  const context = {
    beginPath: vi.fn(),
    clearRect: vi.fn(),
    drawImage: vi.fn(),
    fillRect: vi.fn(),
    lineTo: vi.fn(),
    moveTo: vi.fn(),
    stroke: vi.fn(),
    fillStyle: '',
    lineWidth: 1,
    strokeStyle: ''
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
  Object.defineProperty(HTMLCanvasElement.prototype, 'toBlob', {
    configurable: true,
    value: (callback: BlobCallback) => callback(new Blob(['confirmed jpeg'], { type: 'image/jpeg' }))
  });
});

test('the avatar is the photo chooser and crop cancellation restores focus to it', async () => {
  const user = userEvent.setup();
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  renderSettings(listenerWithoutAvatar);

  const avatarButton = screen.getByRole('button', { name: 'Edit profile photo' });
  const input = screen.getByLabelText('Choose profile photo');
  const inputClick = vi.spyOn(input, 'click');
  expect(input).not.toBeVisible();
  expect(screen.queryByRole('button', { name: 'Change photo' })).not.toBeInTheDocument();
  expect(avatarButton.querySelector('.lucide-pencil')).toHaveAttribute('aria-hidden', 'true');

  avatarButton.focus();
  await user.keyboard('{Enter}');
  expect(inputClick).toHaveBeenCalledOnce();
  await user.keyboard(' ');
  expect(inputClick).toHaveBeenCalledTimes(2);
  await user.click(avatarButton);
  expect(inputClick).toHaveBeenCalledTimes(3);
  await user.upload(input, new File(['photo'], 'photo.jpg', { type: 'image/jpeg' }));

  const dialog = await screen.findByRole('dialog', { name: 'Position your photo' });
  const close = screen.getByRole('button', { name: 'Cancel profile photo' });
  await waitFor(() => expect(close).toHaveFocus());
  fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
  expect(screen.getByRole('button', { name: 'Preview crop' })).toHaveFocus();

  await user.click(close);
  expect(dialog).not.toBeInTheDocument();
  expect(avatarButton).toHaveFocus();
  expect(fetchMock).not.toHaveBeenCalled();
});

test('requires a separate circular preview confirmation before uploading', async () => {
  const user = userEvent.setup();
  const response = {
    avatarRevision: 1,
    avatar: { assetId: 'avatar-1', revision: 1 },
    cleanupPending: false
  };
  let finishUpload!: (response: Response) => void;
  const uploadResponse = new Promise<Response>((resolve) => { finishUpload = resolve; });
  const fetchMock = vi.fn(() => uploadResponse);
  vi.stubGlobal('fetch', fetchMock);
  const { onAvatarChange, queryClient } = renderSettings(listenerWithoutAvatar);

  await user.upload(
    screen.getByLabelText('Choose profile photo'),
    new File(['photo'], 'photo.png', { type: 'image/png' })
  );
  await screen.findByRole('dialog', { name: 'Position your photo' });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Preview crop' })).toBeEnabled());
  expect(fetchMock).not.toHaveBeenCalled();

  await user.click(screen.getByRole('button', { name: 'Preview crop' }));
  await screen.findByRole('dialog', { name: 'Use this profile photo?' });
  await waitFor(() => expect(
    screen.getByRole('button', { name: 'Cancel profile photo' })
  ).toHaveFocus());
  expect(screen.getByAltText('Circular preview of the selected profile photo')).toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalled();

  await user.click(screen.getByRole('button', { name: 'Back to crop' }));
  await screen.findByRole('dialog', { name: 'Position your photo' });
  await waitFor(() => expect(
    screen.getByRole('button', { name: 'Cancel profile photo' })
  ).toHaveFocus());
  await user.click(screen.getByRole('button', { name: 'Preview crop' }));
  await screen.findByRole('dialog', { name: 'Use this profile photo?' });

  await user.click(screen.getByRole('button', { name: 'Use photo' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  const avatarButton = screen.getByRole('button', { name: 'Edit profile photo' });
  expect(avatarButton).toBeDisabled();
  expect(avatarButton).toHaveAttribute('aria-busy', 'true');
  expect(screen.getByRole('status')).toHaveTextContent('Uploading photo…');

  await act(async () => finishUpload(new Response(JSON.stringify(response), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'X-Finitude-Account-Viewer': 'listener-1'
    }
  })));
  await waitFor(() => expect(onAvatarChange).toHaveBeenCalledWith(response));
  expect(avatarButton).toBeEnabled();
  expect(avatarButton).toHaveAttribute('aria-busy', 'false');
  expect(queryClient.getQueryData<BrowserSession>(browserSessionQueryKey)?.user).toMatchObject({
    id: 'listener-1',
    avatarRevision: 1,
    avatar: { assetId: 'avatar-1', revision: 1 }
  });
  expect(await screen.findByText('Profile photo updated.')).toBeInTheDocument();
});

test('does not create a preview URL after the crop dialog is unmounted', async () => {
  const user = userEvent.setup();
  let finishEncoding!: BlobCallback;
  Object.defineProperty(HTMLCanvasElement.prototype, 'toBlob', {
    configurable: true,
    value: (callback: BlobCallback) => { finishEncoding = callback; }
  });
  vi.stubGlobal('fetch', vi.fn());
  const view = renderSettings(listenerWithoutAvatar);

  await user.upload(
    screen.getByLabelText('Choose profile photo'),
    new File(['photo'], 'photo.jpg', { type: 'image/jpeg' })
  );
  await waitFor(() => expect(screen.getByRole('button', { name: 'Preview crop' })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: 'Preview crop' }));
  expect(screen.getByRole('button', { name: 'Preparing…' })).toBeDisabled();

  view.unmount();
  await act(async () => finishEncoding(new Blob(['late jpeg'], { type: 'image/jpeg' })));
  expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
});

test('discards a failed upload candidate without presenting a retry action', async () => {
  const user = userEvent.setup();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: 'Upload failed.' }), {
    status: 500,
    headers: { 'Content-Type': 'application/json' }
  })));
  renderSettings(listenerWithoutAvatar);

  await user.upload(
    screen.getByLabelText('Choose profile photo'),
    new File(['photo'], 'photo.webp', { type: 'image/webp' })
  );
  await waitFor(() => expect(screen.getByRole('button', { name: 'Preview crop' })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: 'Preview crop' }));
  await user.click(await screen.findByRole('button', { name: 'Use photo' }));

  expect(await screen.findByRole('alert')).toHaveTextContent('current photo has not changed');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Edit profile photo' })).toBeEnabled();
});

test('hides and discards an editor candidate on the first render of an account switch', async () => {
  const user = userEvent.setup();
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  const { queryClient, rerender } = renderSettings(listenerWithoutAvatar);

  await user.upload(
    screen.getByLabelText('Choose profile photo'),
    new File(['photo'], 'photo.jpg', { type: 'image/jpeg' })
  );
  await screen.findByRole('dialog', { name: 'Position your photo' });

  const nextUser = {
    ...listenerWithoutAvatar,
    id: 'listener-2',
    displayName: 'Listener Two',
    email: 'two@example.com'
  };
  queryClient.setQueryData(browserSessionQueryKey, sessionFor(nextUser));
  rerender(
    <QueryClientProvider client={queryClient}>
      <AvatarSettings user={nextUser} />
    </QueryClientProvider>
  );

  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalled();
  await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:avatar-1'));
});

test('delete confirmation stays open while pending and clears only after server success', async () => {
  const user = userEvent.setup();
  let finishDelete!: (response: Response) => void;
  const deleteResponse = new Promise<Response>((resolve) => { finishDelete = resolve; });
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === '/auth/avatar' && init?.method === 'DELETE') return deleteResponse;
    return Promise.resolve(new Response(new Blob(['current avatar']), {
      status: 200,
      headers: {
        'Content-Type': 'image/jpeg',
        'X-Finitude-Account-Viewer': 'listener-1'
      }
    }));
  });
  vi.stubGlobal('fetch', fetchMock);
  const { queryClient } = renderSettings(listenerWithAvatar);

  const removeTrigger = screen.getByRole('button', { name: 'Remove photo' });
  await user.click(removeTrigger);
  expect(screen.getByRole('button', { name: 'Keep photo' })).toHaveFocus();
  fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
  expect(screen.getAllByRole('button', { name: 'Remove photo' }).at(-1)).toHaveFocus();

  await user.click(screen.getAllByRole('button', { name: 'Remove photo' }).at(-1)!);
  expect(screen.getByRole('dialog', { name: 'Remove your photo?' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Removing…' })).toBeDisabled();
  expect(queryClient.getQueryData<BrowserSession>(browserSessionQueryKey)?.user.avatar).not.toBeNull();

  await act(async () => finishDelete(new Response(JSON.stringify({
    avatarRevision: 4,
    avatar: null
  }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'X-Finitude-Account-Viewer': 'listener-1'
    }
  })));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Remove your photo?' })).not.toBeInTheDocument());
  expect(queryClient.getQueryData<BrowserSession>(browserSessionQueryKey)?.user.avatar).toBeNull();
  expect(screen.getByText('Profile photo removed.')).toBeInTheDocument();
});

test('standalone crop dialog restores focus to its explicit parent control', async () => {
  const Harness = () => {
    const [open, setOpen] = useState(false);
    const triggerRef = useRef<HTMLButtonElement>(null);
    return (
      <>
        <button onClick={() => setOpen(true)} ref={triggerRef} type="button">Open crop</button>
        {open && (
          <AvatarCropDialog
            onCancel={() => setOpen(false)}
            onUsePhoto={() => undefined}
            returnFocusRef={triggerRef}
            sourceUrl="blob:test"
          />
        )}
      </>
    );
  };
  const user = userEvent.setup();
  render(<Harness />);
  const trigger = screen.getByRole('button', { name: 'Open crop' });
  await user.click(trigger);
  await user.keyboard('{Escape}');
  expect(trigger).toHaveFocus();
});
