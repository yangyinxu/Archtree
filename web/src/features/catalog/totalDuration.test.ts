import { durationSeconds, formatTotalDuration, totalDurationSeconds } from './totalDuration';

const t = ((key: string, values: Record<string, number>) => key === 'playlist.duration.hours'
  ? `${values.hours} hr ${values.minutes} min`
  : `${values.minutes} min`) as unknown as Parameters<typeof formatTotalDuration>[1];

test('parses m:ss and h:mm:ss, and rejects missing or malformed durations', () => {
  expect(durationSeconds('3:24')).toBe(204);
  expect(durationSeconds('1:02:03')).toBe(3723);
  expect(durationSeconds(null)).toBeNull();
  expect(durationSeconds('')).toBeNull();
  expect(durationSeconds('42')).toBeNull();
  expect(durationSeconds('1:2:3:4')).toBeNull();
  expect(durationSeconds('a:10')).toBeNull();
  for (const malformed of ['1:', ':30', '1:2', '1:60', '1:60:00', '1.5:30', '1e2:30', ' 1:30', '-1:30', '9007199254740991:00']) {
    expect(durationSeconds(malformed)).toBeNull();
  }
  expect(durationSeconds('90:00')).toBe(5400);
});

test('a total is known only when every duration is known', () => {
  expect(totalDurationSeconds([{ duration: '3:24' }, { duration: '1:00:00' }])).toBe(3804);
  expect(totalDurationSeconds([{ duration: '3:24' }, { duration: null }])).toBeNull();
  expect(totalDurationSeconds([])).toBe(0);
});

test('formats hours with minutes, and minutes with a floor of 1 min', () => {
  expect(formatTotalDuration(4320, t)).toBe('1 hr 12 min');
  expect(formatTotalDuration(204, t)).toBe('3 min');
  expect(formatTotalDuration(20, t)).toBe('1 min');
});
