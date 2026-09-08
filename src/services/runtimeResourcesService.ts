import { statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { getCoverArtSchedulingSnapshot } from './coverArtVariantScheduler';

/** Reports storage headroom without exposing a filesystem path or file inventory. */
export const createRuntimeResourceReader = (
  readFilesystem = () => statfs(tmpdir()),
  now = Date.now
) => {
  let cached: { availableBytes: number; totalBytes: number } | null = null;
  let checkedAt = -Infinity;
  let pending: Promise<void> | undefined;
  return async () => {
    if (now() - checkedAt >= 30_000 && !pending) {
      pending = readFilesystem().then(stats => {
        cached = { availableBytes: stats.bavail * stats.bsize, totalBytes: stats.blocks * stats.bsize };
      }, () => { cached = null; }).finally(() => { checkedAt = now(); pending = undefined; });
    }
    await pending;
    return { scope: 'process' as const, temporaryStorage: cached, artwork: getCoverArtSchedulingSnapshot() };
  };
};

export const getRuntimeResources = createRuntimeResourceReader();
