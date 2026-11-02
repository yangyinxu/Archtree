import readBufferedRanges, { EMPTY_BUFFERED_RANGES } from './bufferedRanges';
import type { PlayerAudio } from './types';

/** Supplies only the native properties used at the buffered-range boundary. */
const mediaWithRanges = (intervals: readonly (readonly [number, number])[]) => ({
  src: new URL('/stream/current', location.href).href,
  currentSrc: '/stream/current',
  duration: 120,
  readyState: 4,
  buffered: {
    length: intervals.length,
    start: (index: number) => intervals[index][0],
    end: (index: number) => intervals[index][1]
  }
} as PlayerAudio);

test('clips available native intervals to duration and omits invalid ranges without filling gaps', () => {
  const media = mediaWithRanges([[-2, 20], [50, 140], [100, 99], [40, 40], [NaN, 10], [0, Infinity], [125, 130]]);
  expect(readBufferedRanges(media, '/stream/current', [])).toEqual([
    { start: 0, end: 20 }, { start: 50, end: 120 }
  ]);
});

test.each([0, -1, NaN, Infinity])('unknown or invalid duration %s cannot imply a buffered percentage', duration => {
  const media = { ...mediaWithRanges([[0, 60]]), duration };
  expect(readBufferedRanges(media, '/stream/current', [{ start: 0, end: 10 }])).toBe(EMPTY_BUFFERED_RANGES);
});

test('rejects unloaded, mismatched and unavailable sources', () => {
  const media = mediaWithRanges([[0, 60]]);
  expect(readBufferedRanges({ ...media, readyState: 0 }, '/stream/current', [])).toEqual([]);
  expect(readBufferedRanges({ ...media, src: '/stream/old' }, '/stream/current', [])).toEqual([]);
  expect(readBufferedRanges({ ...media, currentSrc: '/stream/old' }, '/stream/current', [])).toEqual([]);
  expect(readBufferedRanges(media, '', [])).toEqual([]);
  expect(readBufferedRanges({ ...media, buffered: undefined }, '/stream/current', [])).toEqual([]);
});

test('a native reset during range access clears all ranges rather than publishing a partial buffer', () => {
  const media = mediaWithRanges([[0, 30], [60, 90]]);
  const unstable = {
    ...media,
    buffered: {
      ...media.buffered!,
      end: (index: number) => {
        if (index === 1) throw new DOMException('Range no longer exists', 'IndexSizeError');
        return 30;
      }
    }
  };
  expect(readBufferedRanges(unstable, '/stream/current', [{ start: 0, end: 120 }])).toBe(EMPTY_BUFFERED_RANGES);
});
