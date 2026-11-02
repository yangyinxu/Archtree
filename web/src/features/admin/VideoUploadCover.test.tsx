import { cleanup, render, screen } from '@testing-library/react';
import { VideoUploadCover } from './VideoUploadCover';
import { videoProject } from './videoUploadFixtures.testSupport';

vi.mock('./AdminAccess', () => ({ useAdminAccess: () => ({ viewerId: 'synthetic-viewer' }) }));
vi.mock('./adminPageText', () => ({ useAdminDeliveryText: () => (key: string) => key }));
afterEach(cleanup);

test('queued and running cover jobs announce their actual state after main processing is complete', () => {
  const project = videoProject(), onFrame = vi.fn();
  const props = { draft: project.draft, localUrl: 'blob:synthetic-original', disabled: true, onImage: vi.fn(), onChoice: vi.fn(), onFrame };
  const { rerender } = render(<VideoUploadCover {...props} project={{ ...project, frame: { state: 'queued', issue: null } }} />);
  expect(screen.getByRole('status')).toHaveTextContent('video.cover · video.state_queued');
  expect(screen.getByRole('button', { name: 'video.cover_frame' })).toBeDisabled();
  rerender(<VideoUploadCover {...props} project={{ ...project, frame: { state: 'running', issue: null } }} />);
  expect(screen.getByRole('status')).toHaveTextContent('video.cover · video.state_running');
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument(); expect(onFrame).not.toHaveBeenCalled();
});

test('settled cover jobs clear active announcements and keep the existing failure recovery message', () => {
  const project = videoProject();
  const props = { draft: project.draft, localUrl: 'blob:synthetic-original', disabled: false, onImage: vi.fn(), onChoice: vi.fn(), onFrame: vi.fn() };
  const { rerender } = render(<VideoUploadCover {...props} project={{ ...project, frame: { state: 'running', issue: null } }} />);
  expect(screen.getByRole('status')).toHaveTextContent('video.state_running');
  rerender(<VideoUploadCover {...props} project={{ ...project, frame: { state: 'ready', issue: null } }} />);
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  rerender(<VideoUploadCover {...props} project={{ ...project, frame: { state: 'failed', issue: 'processing_failed' } }} />);
  expect(screen.getByRole('status')).toHaveTextContent('video.frame_failed');
  expect(screen.queryByText(/video.state_(queued|running)/)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'video.cover_frame' })).toBeEnabled();
  rerender(<VideoUploadCover {...props} project={project} />);
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});
