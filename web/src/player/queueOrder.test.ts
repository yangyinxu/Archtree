import { copyQueue, currentCycleHistory, queueLaunchOrder, shuffledOrder } from './queueOrder';

test.each([
  () => 0,
  () => 1,
  () => -8,
  () => Number.NaN,
  () => Number.POSITIVE_INFINITY,
  () => { throw new Error('random unavailable'); }
])('shuffle preserves membership and the selected item even with an unusual random provider', (random) => {
  const original = Object.freeze([0, 1, 2, 3, 4]);
  expect(shuffledOrder(original, random).sort()).toEqual(original);
  const launched = queueLaunchOrder(5, 2, true, random);
  expect(launched[0]).toBe(2);
  expect([...launched].sort()).toEqual(original);
  expect(queueLaunchOrder(5, 2, false, random)).toEqual(original);
});

test('returning from previous navigation excludes future history when shuffle is enabled', () => {
  expect(currentCycleHistory([0, 1, 2, 1, 3, 4], 3)).toEqual([0, 2, 1]);
  expect(currentCycleHistory([0, 1], -1)).toEqual([]);
});

test('a launched queue is unaffected when its source metadata or playlist is edited', () => {
  const artistNames = ['Original artist'];
  const item = {
    id: 'track', title: 'Original title', artworkUrl: '', artistNames,
    mediaType: 'audio' as const, streamUrl: '/stream'
  };
  const source = [item];
  const queue = copyQueue(source);
  item.title = 'Edited title';
  artistNames.push('Later artist');
  source.splice(0);
  expect(queue).toHaveLength(1);
  expect(queue[0].title).toBe('Original title');
  expect(queue[0].artistNames).toEqual(['Original artist']);
  expect(Object.isFrozen(queue[0].artistNames)).toBe(true);
});
