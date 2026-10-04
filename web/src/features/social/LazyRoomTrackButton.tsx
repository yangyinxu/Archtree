import { lazy, Suspense, useState } from 'react';
import type { RoomTrackButtonProps } from './RoomTrackButton';
import { useSocialAvailability } from './socialAvailability';

const DeferredRoomTrackButton = lazy(() => import('./RoomTrackButton'));
/**
 * Catalog and player entry points do not preload room transport or private friend selection, and never
 * download it while rooms are disabled. Once loaded, the button hides itself so an open dialog can
 * explain a rollout change instead of vanishing.
 */
export const LazyRoomTrackButton = (props: RoomTrackButtonProps) => {
  const { roomsEnabled } = useSocialAvailability();
  const [loaded, setLoaded] = useState(roomsEnabled);
  if (roomsEnabled && !loaded) setLoaded(true);
  return loaded ? <Suspense fallback={null}><DeferredRoomTrackButton {...props} /></Suspense> : null;
};
