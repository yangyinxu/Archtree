import { lazy, Suspense } from 'react';

import type { AddTrackToPlaylistButtonProps } from './AddTrackToPlaylistButton';

const DeferredAddTrackToPlaylistButton = lazy(() => import('./AddTrackToPlaylistButton'));

/** Defers interaction-only Playlist code until a result row actually renders. */
export const LazyAddTrackToPlaylistButton = (props: AddTrackToPlaylistButtonProps) => (
  <Suspense fallback={null}>
    <DeferredAddTrackToPlaylistButton {...props} />
  </Suspense>
);
