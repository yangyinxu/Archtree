import { lazy, Suspense } from 'react';
import type { ShareMusicButtonProps } from './ShareMusicButton';

const DeferredShareMusicButton = lazy(() => import('./ShareMusicButton'));
/** Keeps friend selection and account-owned sharing code outside catalog startup chunks. */
export const LazyShareMusicButton = (props: ShareMusicButtonProps) => <Suspense fallback={null}><DeferredShareMusicButton {...props} /></Suspense>;
