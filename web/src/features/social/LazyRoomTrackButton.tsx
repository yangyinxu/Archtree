import { lazy, Suspense } from 'react';
import type { RoomTrackButtonProps } from './RoomTrackButton';

const DeferredRoomTrackButton = lazy(() => import('./RoomTrackButton'));
/** Catalog and player entry points do not preload room transport or private friend selection. */
export const LazyRoomTrackButton = (props: RoomTrackButtonProps) => <Suspense fallback={null}><DeferredRoomTrackButton {...props} /></Suspense>;
