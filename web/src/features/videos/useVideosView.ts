import { useCallback, useState } from 'react';

export type VideosView = 'grid' | 'immersive';
const storageKey = 'finitude:video-browse-view';

/** A device-only presentation preference contains no viewer or catalog data. */
const readView = (): VideosView => {
  try { return window.localStorage.getItem(storageKey) === 'immersive' ? 'immersive' : 'grid'; }
  catch { return 'grid'; }
};

/** Storage denial never prevents switching the current page or changes the shared player. */
export const useVideosView = () => {
  const [view, setView] = useState<VideosView>(readView);
  const chooseView = useCallback((next: VideosView) => {
    setView(next);
    try { window.localStorage.setItem(storageKey, next); } catch { /* The in-memory choice still applies. */ }
  }, []);
  return [view, chooseView] as const;
};
