import { cleanup, render, screen } from '@testing-library/react';
import { VideoProcessingProgress, VideoTransferProgress } from './VideoUploadProgress';

vi.mock('./adminPageText', () => ({ useAdminDeliveryText: () => (key: string) => key }));
afterEach(cleanup);

test('upload progress displays measured percentage and byte counts separately from confirmation', () => {
  const { rerender } = render(<VideoTransferProgress kind="source" progress={{ loaded: 1024 ** 2, total: 4 * 1024 ** 2 }} />);
  expect(screen.getByText('25%')).toBeInTheDocument();
  expect(screen.getByText('1.0 MiB / 4.0 MiB')).toBeInTheDocument();
  expect(screen.getByRole('progressbar', { name: 'video.transmitting' })).toHaveAttribute('value', '25');
  expect(screen.queryByText('video.transfer_waiting')).not.toBeInTheDocument();
  rerender(<VideoTransferProgress kind="source" progress={{ loaded: 4 * 1024 ** 2, total: 4 * 1024 ** 2 }} />);
  expect(screen.getByText('100%')).toBeInTheDocument(); expect(screen.getByRole('status')).toHaveTextContent('video.transfer_waiting');
});

test('unknown transfer totals remain indeterminate and cover transfers have their own label', () => {
  render(<VideoTransferProgress kind="covers" progress={{ loaded: 1024 ** 2, total: null }} />);
  expect(screen.getByRole('progressbar', { name: 'video.transmitting_cover' })).not.toHaveAttribute('value');
  expect(screen.getByText('1.0 MiB')).toBeInTheDocument(); expect(screen.queryByText(/%/)).not.toBeInTheDocument();
});

test('processing exposes a numeric percentage for the current step and never rounds unfinished work to 100%', () => {
  const { rerender } = render(<VideoProcessingProgress progress={37} />);
  expect(screen.getByText('37%')).toBeInTheDocument(); expect(screen.getByText(/video.processing_progress_help/)).toBeInTheDocument();
  expect(screen.getByRole('progressbar', { name: 'video.stage_2' })).toHaveAttribute('value', '37');
  rerender(<VideoProcessingProgress progress={99.9} />); expect(screen.getByText('99%')).toBeInTheDocument();
  rerender(<VideoProcessingProgress progress={null} />);
  expect(screen.getByRole('progressbar', { name: 'video.stage_2' })).not.toHaveAttribute('value');
  expect(screen.queryByText(/%/)).not.toBeInTheDocument();
});
