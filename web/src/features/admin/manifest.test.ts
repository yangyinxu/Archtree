import { namingManifest } from './manifest';

test('folder selection preserves root and nested naming evidence but excludes other files', () => {
  let n = 0;
  const result = namingManifest([
    { name: '01 Song.mp3', size: 100, webkitRelativePath: 'Album/CD1/01 Song.mp3' },
    { name: '01 Song.mp3', size: 200, webkitRelativePath: 'Album/CD2/01 Song.mp3' },
    { name: 'cover.jpg', size: 20, webkitRelativePath: 'Album/cover.jpg' }
  ], () => String(++n));
  expect(result.rootLabel).toBe('Album');
  expect(result.files.map(file => file.relativePath)).toEqual(['Album/CD1/01 Song.mp3', 'Album/CD2/01 Song.mp3']);
  expect(result.files.map(file => file.slotId)).toEqual(['1', '2']);
  expect(result.files[0]).not.toHaveProperty('url');
});

test('multi-file selection never invents containing folders and rejects ambiguous same-name rows', () => {
  const result = namingManifest([{ name: 'Song.mp3', size: 1, webkitRelativePath: '' }]);
  expect(result.rootLabel).toBe('');
  expect(result.files).toHaveLength(1);
  expect(() => namingManifest(Array.from({ length: 2 }, () => ({ name: 'Song.mp3', size: 1, webkitRelativePath: '' })))).toThrow();
});

test.each(['/private/Album/Song.mp3', '../Song.mp3', 'Album/../Song.mp3', 'Album\\Song.mp3', 'Album/\u0000/Song.mp3'])(
  'rejects unsafe or absolute relative path %s', path => {
    expect(() => namingManifest([{ name: 'Song.mp3', size: 1, webkitRelativePath: path }])).toThrow();
  }
);

test('bounds the complete manifest before submission', () => {
  expect(() => namingManifest([])).toThrow();
  expect(() => namingManifest(Array.from({ length: 100 }, (_, index) => ({ name: `${index}${'中'.repeat(90)}.mp3`, size: 1, webkitRelativePath: '' })))).toThrow();
  expect(() => namingManifest(Array.from({ length: 101 }, () => ({ name: 'Song.mp3', size: 1, webkitRelativePath: '' })))).toThrow();
});
