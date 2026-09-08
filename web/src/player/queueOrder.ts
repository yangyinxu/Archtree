import type { PlayerQueueItem } from './types';

/** Queue ownership never aliases caller arrays or caller-owned artist metadata. */
export const copyQueue = (queue: readonly PlayerQueueItem[]): readonly PlayerQueueItem[] =>
  Object.freeze(queue.map((item) => Object.freeze({
    ...item,
    artistNames: Object.freeze([...item.artistNames])
  })));

/** Canonical indices remain the persistent queue's order even while shuffled. */
export const canonicalOrder = (length: number) => Array.from({ length }, (_, index) => index);

/** An injected random source cannot drop, duplicate, or invent queue positions. */
export const shuffledOrder = (indices: readonly number[], random: () => number): number[] => {
  const result = [...indices];
  for (let index = result.length - 1; index > 0; index -= 1) {
    let value = 0;
    try {
      const candidate = random();
      value = Number.isFinite(candidate) ? Math.min(Math.max(candidate, 0), 0.999999999999) : 0;
    } catch {
      // Optional random providers cannot prevent transport from remaining usable.
    }
    const swapIndex = Math.floor(value * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
};

/** Shuffle launch begins with the explicitly selected track and retains every member. */
export const queueLaunchOrder = (
  length: number,
  currentIndex: number,
  shuffleEnabled: boolean,
  random: () => number
) => {
  const canonical = canonicalOrder(length);
  return shuffleEnabled
    ? [currentIndex, ...shuffledOrder(canonical.filter((index) => index !== currentIndex), random)]
    : canonical;
};

/** Keeps the actual history up to the cursor, with each position's latest visit retained. */
export const currentCycleHistory = (history: readonly number[], position: number): number[] => {
  const uniqueHistory: number[] = [];
  history.slice(0, position + 1).forEach((index) => {
    const earlierPosition = uniqueHistory.indexOf(index);
    if (earlierPosition >= 0) uniqueHistory.splice(earlierPosition, 1);
    uniqueHistory.push(index);
  });
  return uniqueHistory;
};
