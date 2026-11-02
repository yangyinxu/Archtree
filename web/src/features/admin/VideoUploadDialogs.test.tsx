import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import VideoUploadDialogs from './VideoUploadDialogs';
import { videoProject } from './videoUploadFixtures.testSupport';

vi.mock('./AdminAccess', () => ({ useAdminAccess: () => ({ viewerId: 'synthetic-viewer' }) }));
vi.mock('./adminPageText', () => ({ useAdminDeliveryText: () => (key: string) => key }));
const props = () => ({ approval: null, current: videoProject(), disabled: false, ready: true, cancelling: false, onClose: vi.fn(), onPublish: vi.fn(), onCancel: vi.fn() });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

test('a native decode failure already settled during mount renders the fallback without a later error event', () => {
  const prototype = Object.getPrototypeOf(document.createElement('video')) as object;
  const original = Object.getOwnPropertyDescriptor(prototype, 'error');
  Object.defineProperty(prototype, 'error', { configurable: true, get: () => ({ code: 4 }) });
  try {
    const { container } = render(<VideoUploadDialogs {...props()} previewUrl="blob:invalid-source" />);
    expect(screen.getByText('video.preview_unavailable')).toBeInTheDocument();
    expect(container.querySelector('video')).not.toBeInTheDocument();
  } finally { if (original) Object.defineProperty(prototype, 'error', original); else Reflect.deleteProperty(prototype, 'error'); }
});

test('fast media errors persist through parent updates and a different source gets independent state', () => {
  const initial = props(), { container, rerender } = render(<VideoUploadDialogs {...initial} previewUrl="blob:first-source" />);
  const first = container.querySelector('video')!; fireEvent.error(first);
  expect(screen.getByText('video.preview_unavailable')).toBeInTheDocument();
  rerender(<VideoUploadDialogs {...initial} current={{ ...initial.current, revision: 4 }} previewUrl="blob:first-source" />);
  expect(screen.getByText('video.preview_unavailable')).toBeInTheDocument();
  rerender(<VideoUploadDialogs {...initial} previewUrl="blob:second-source" />);
  const second = container.querySelector('video')!;
  expect(second).toHaveAttribute('src', 'blob:second-source');
  expect(screen.queryByText('video.preview_unavailable')).not.toBeInTheDocument();
  fireEvent.error(first);
  expect(container.querySelector('video')).toBe(second);
  fireEvent.error(second);
  expect(screen.getByText('video.preview_unavailable')).toBeInTheDocument();
});
