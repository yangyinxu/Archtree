import { useCallback, useState } from 'react';

export type VideosView = 'grid' | 'immersive';
const storageKey = 'finitude:video-browse-view';

/** A device-only presentation preference contains no viewer or catalog data. */
const readView = (): VideosView | null => {
  try {
    const stored = window.localStorage.getItem(storageKey);
    return stored === 'immersive' || stored === 'grid' ? stored : null;
  } catch { return null; }
};

/** Storage denial never prevents switching the current page or changes the shared player. */
export const useVideosView = (defaultView: VideosView = 'grid') => {
  const [view, setView] = useState<VideosView | null>(readView);
  const chooseView = useCallback((next: VideosView) => {
    setView(next);
    try { window.localStorage.setItem(storageKey, next); } catch { /* The in-memory choice still applies. */ }
  }, []);
  return [view ?? defaultView, chooseView] as const;
};
