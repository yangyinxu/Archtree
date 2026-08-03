export const RESPONSIVE_ARTWORK_WIDTHS = [
  96,
  192,
  320,
  480,
  640,
  960,
  1280
] as const;

export interface MediaSessionArtworkSource {
  src: string;
  sizes?: string;
  type?: string;
}

const managedArtworkPattern = /^\/content\/images\/[0-9a-fA-F]{24}$/;

/** Derives only versioned, allowlisted variants from an exact managed-image URL. */
const responsiveArtworkVariants = (source: string) => {
  if (!managedArtworkPattern.test(source)) return [];
  return RESPONSIVE_ARTWORK_WIDTHS.map((width) => ({
    src: `${source}/v1/${width}.webp`,
    width
  }));
};

/** Builds an HTML srcset while leaving the original image URL as the img fallback. */
export const responsiveArtworkSrcSet = (source: string) => responsiveArtworkVariants(source)
  .map(({ src, width }) => `${src} ${width}w`)
  .join(', ');

/** Gives Media Session explicit square WebP sizes without rewriting non-managed URLs. */
export const mediaSessionArtworkSources = (source: string): MediaSessionArtworkSource[] => {
  const variants = responsiveArtworkVariants(source);
  if (variants.length > 0) {
    return variants.map(({ src, width }) => ({
      src,
      sizes: `${width}x${width}`,
      type: 'image/webp'
    }));
  }
  return source ? [{ src: source }] : [];
};
