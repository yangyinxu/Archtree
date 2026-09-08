import { captureAccountOperation, advanceAccountEpoch } from '../../api/accountEpoch';
import { recordRecentlyPlayed } from '../../api/listener';
import { queryClient } from '../../app/queryClient';
import { recordPlaybackHistory } from './recordPlaybackHistory';

vi.mock('../../api/listener', () => ({ recordRecentlyPlayed: vi.fn() }));

const target = { contentType: 'audioTrack' as const, contentId: 'track' };

test('successful playback refreshes only the recording viewer collections', async () => {
  vi.mocked(recordRecentlyPlayed).mockResolvedValue({ ...target, recorded: true });
  const refresh = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue();
  await recordPlaybackHistory(target, 'viewer', captureAccountOperation('viewer'));
  expect(refresh.mock.calls).toEqual([
    [{ queryKey: ['listener', 'library', 'viewer'] }],
    [{ queryKey: ['listener', 'home', 'viewer'] }]
  ]);
});

test('an account transition prevents a deferred history write', async () => {
  const guard = captureAccountOperation('viewer');
  advanceAccountEpoch();
  await recordPlaybackHistory(target, 'viewer', guard);
  expect(recordRecentlyPlayed).not.toHaveBeenCalled();
});

test('an account transition during the request prevents stale refreshes', async () => {
  const refresh = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue();
  vi.mocked(recordRecentlyPlayed).mockImplementation(async () => {
    advanceAccountEpoch();
    return { ...target, recorded: true };
  });
  await recordPlaybackHistory(target, 'viewer', captureAccountOperation('viewer'));
  expect(refresh).not.toHaveBeenCalled();
});
