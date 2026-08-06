import {
  mediaSessionArtworkSources,
  RESPONSIVE_ARTWORK_WIDTHS,
  responsiveArtworkSrcSet
} from './artworkUrls';

const managedSource = '/content/images/0123456789abcdef01234567';

test('builds every fixed v1 WebP candidate for an exact managed image URL', () => {
  expect(responsiveArtworkSrcSet(managedSource)).toBe(
    RESPONSIVE_ARTWORK_WIDTHS
      .map((width) => `${managedSource}/v1/${width}.webp ${width}w`)
      .join(', ')
  );
  expect(mediaSessionArtworkSources(managedSource)).toEqual(
    RESPONSIVE_ARTWORK_WIDTHS.map((width) => ({
      src: `${managedSource}/v1/${width}.webp`,
      sizes: `${width}x${width}`,
      type: 'image/webp'
    }))
  );
});

test.each([
  '',
  'https://images.example.com/cover.webp',
  'blob:https://listener.example.com/preview-id',
  'data:image/webp;base64,AAAA',
  '/content/images/0123456789abcdef01234567?revision=2',
  '/content/images/not-an-object-id'
])('does not derive variants for %j', (source) => {
  expect(responsiveArtworkSrcSet(source)).toBe('');
  expect(mediaSessionArtworkSources(source)).toEqual(source ? [{ src: source }] : []);
});
