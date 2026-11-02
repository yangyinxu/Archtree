import type { PlayerBufferedRange } from '../player/types';

/** Paints the store's validated intervals without filling unbuffered seek gaps. */
export const bufferedProgressGradient = (
  ranges: readonly PlayerBufferedRange[],
  duration: number
): string => {
  if (!Number.isFinite(duration) || duration <= 0) return 'none';
  const stops = ranges.map(({ start, end }) => {
    const from = start / duration * 100;
    const to = end / duration * 100;
    return `transparent ${from}%, var(--color-text-subtle) ${from}% ${to}%, transparent ${to}%`;
  });
  return stops.length > 0 ? `linear-gradient(to right, ${stops.join(', ')})` : 'none';
};
