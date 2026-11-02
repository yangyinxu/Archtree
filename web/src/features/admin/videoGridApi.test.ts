import { videoGridResponse } from './videoGridApi';

const item = { id: '111111111111111111111111', title: 'Synthetic Video', coverUrl: null, creator: null };
const grid = { revision: `cr_${'a'.repeat(43)}`, defaultView: 'grid', items: [item] };

test('Video Grid accepts only complete allowlisted snapshots and supported default views', () => {
  expect(videoGridResponse.parse({ grid })).toEqual({ grid });
  for (const invalid of [
    { ...grid, defaultView: 'carousel' },
    { ...grid, items: [item, item] },
    { ...grid, items: [{ ...item, id: 'invalid' }] },
    { ...grid, items: [{ ...item, createdBy: 'private-owner' }] },
    { ...grid, revision: 'stale' },
    { ...grid, items: Array.from({ length: 5_001 }, (_, index) => ({ ...item, id: index.toString(16).padStart(24, '0') })) }
  ]) expect(videoGridResponse.safeParse({ grid: invalid }).success).toBe(false);
});
