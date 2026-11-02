import type { PlayerAudio, PlayerBufferedRange } from './types';

export const EMPTY_BUFFERED_RANGES: readonly PlayerBufferedRange[] = Object.freeze([]);

/** Resolves media URLs consistently with the shared element's absolute src/currentSrc. */
const absoluteSource = (source: string) => {
  return new URL(source, typeof location === 'undefined' ? 'http://localhost' : location.href).href;
};

/** Copies native ranges without filling seek gaps or retaining a previous source's bytes. */
const readBufferedRanges = (
  media: PlayerAudio,
  source: string,
  previous: readonly PlayerBufferedRange[]
): readonly PlayerBufferedRange[] => {
  const ranges: PlayerBufferedRange[] = [];
  const empty = previous.length === 0 ? previous : EMPTY_BUFFERED_RANGES;
  try {
    const duration = media.duration;
    const selected = absoluteSource(source);
    if (!source || !Number.isFinite(duration) || duration <= 0 || media.readyState === 0
      || absoluteSource(media.src) !== selected
      || (media.currentSrc && absoluteSource(media.currentSrc) !== selected)) return empty;

    const buffered = media.buffered;
    if (buffered) {
      for (let index = 0; index < buffered.length; index += 1) {
        const start = buffered.start(index);
        const end = buffered.end(index);
        if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
        const boundedStart = Math.max(0, start);
        const boundedEnd = Math.min(duration, end);
        if (boundedEnd > boundedStart) ranges.push(Object.freeze({ start: boundedStart, end: boundedEnd }));
      }
    }
  } catch {
    // A reset can invalidate a native TimeRanges index between reading length and start/end.
    return empty;
  }

  if (ranges.length === 0) return empty;
  if (ranges.length === previous.length && ranges.every((range, index) =>
    range.start === previous[index].start && range.end === previous[index].end)) return previous;
  return Object.freeze(ranges);
};

export default readBufferedRanges;
