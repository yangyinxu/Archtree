import { lazy, Suspense, useState } from 'react';
import type { ShareMusicButtonProps } from './ShareMusicButton';
import { useSocialAvailability } from './socialAvailability';

const DeferredShareMusicButton = lazy(() => import('./ShareMusicButton'));
/**
 * Keeps friend selection and account-owned sharing code outside catalog startup chunks, and never
 * downloads it while social is disabled. Once loaded, the button hides itself so an open dialog can
 * explain a rollout change instead of vanishing.
 */
export const LazyShareMusicButton = (props: ShareMusicButtonProps) => {
  const { socialEnabled } = useSocialAvailability();
  const [loaded, setLoaded] = useState(socialEnabled);
  if (socialEnabled && !loaded) setLoaded(true);
  return loaded ? <Suspense fallback={null}><DeferredShareMusicButton {...props} /></Suspense> : null;
};
