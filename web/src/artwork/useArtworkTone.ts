import { useEffect, useState } from 'react';

import { managedArtworkId } from './artworkUrls';

/**
 * Two `#rrggbb` surfaces derived from one artwork colour: `hero` keeps white text at WCAG AA,
 * and the darker `pane` also keeps muted text at AA.
 */
export interface ArtworkTone {
  hero: string;
  pane: string;
}

/** The tone for missing, failed, transparent, or non-managed artwork. */
export const neutralArtworkTone: ArtworkTone = { hero: '#535353', pane: '#333333' };

const toneCacheLimit = 200;
const tones = new Map<string, ArtworkTone | Promise<ArtworkTone>>();
let toneModule: Promise<typeof import('./artworkTone')> | undefined;

/** Shares one lazy import of the color code; a failed chunk load lets a later sample retry it. */
const importToneModule = () => toneModule ??= import('./artworkTone').catch((error: unknown) => {
  toneModule = undefined;
  throw error;
});

/** Returns a known tone at once: neutral for non-managed sources, undefined while unsampled. */
export const peekArtworkTone = (artworkUrl: string | null | undefined): ArtworkTone | undefined => {
  const id = managedArtworkId(artworkUrl?.trim() ?? '');
  if (!id) return neutralArtworkTone;
  const tone = tones.get(id);
  return tone instanceof Promise ? undefined : tone;
};

/**
 * Samples a managed artwork's same-origin 96 px WebP variant once per image id. The color code
 * loads lazily, and any failure settles to (and caches) the neutral tone instead of rejecting.
 */
export const loadArtworkTone = (artworkUrl: string | null | undefined): Promise<ArtworkTone> => {
  const source = artworkUrl?.trim() ?? '';
  const id = managedArtworkId(source);
  if (!id) return Promise.resolve(neutralArtworkTone);
  const known = tones.get(id);
  if (known) return Promise.resolve(known);
  const pending: Promise<ArtworkTone> = importToneModule()
    .then(({ sampleArtworkTone }) => sampleArtworkTone(`${source}/v1/96.webp`))
    .then((tone) => tone ?? neutralArtworkTone, () => neutralArtworkTone)
    .then((tone) => {
      if (tones.get(id) === pending) tones.set(id, tone);
      return tone;
    });
  tones.set(id, pending);
  // Map order is insertion order, so this evicts the oldest image first.
  if (tones.size > toneCacheLimit) tones.delete(tones.keys().next().value!);
  return pending;
};

/** Resolves an artwork's tone: cached tones return at once, and null means the first sample is pending. */
export const useArtworkTone = (artworkUrl: string | null | undefined): ArtworkTone | null => {
  const source = artworkUrl?.trim() ?? '';
  const known = peekArtworkTone(source);
  const [loaded, setLoaded] = useState<{ source: string; tone: ArtworkTone } | null>(null);

  useEffect(() => {
    if (known) return undefined;
    let current = true;
    void loadArtworkTone(source).then((tone) => {
      if (current) setLoaded({ source, tone });
    });
    return () => { current = false; };
  }, [known, source]);

  return known ?? (loaded?.source === source ? loaded.tone : null);
};

/**
 * Sets the registered `--tone-color` on the shell's main pane, whose top gradient animates to it.
 * Writing the property directly keeps the shell entry bundle and Home sections free of re-renders.
 */
export const setMainPaneTone = (color: string | null) => {
  const main = document.getElementById('main-content');
  if (color) main?.style.setProperty('--tone-color', color);
  else main?.style.removeProperty('--tone-color');
};

/** Tints the main pane with `color` while the calling page is mounted. */
export const useMainPaneTone = (color: string | null | undefined) => {
  useEffect(() => {
    if (!color) return undefined;
    setMainPaneTone(color);
    return () => setMainPaneTone(null);
  }, [color]);
};
