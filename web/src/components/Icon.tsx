import { lazy, Suspense } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CircleUserRound,
  Disc3,
  House,
  Globe2,
  Library,
  LockKeyhole,
  Search,
  type LucideIcon,
  type LucideProps
} from 'lucide-react';

export type IconName =
  | 'account'
  | 'arrow-left'
  | 'arrow-right'
  | 'brand'
  | 'check'
  | 'expand'
  | 'home'
  | 'language'
  | 'library'
  | 'lock'
  | 'pause'
  | 'panel-right'
  | 'play'
  | 'previous'
  | 'repeat'
  | 'repeat-one'
  | 'search'
  | 'shuffle'
  | 'next'
  | 'volume'
  | 'volume-off';

export type PlaybackIconName = 'expand' | 'panel-right' | 'pause' | 'play' | 'previous'
  | 'repeat' | 'repeat-one' | 'shuffle' | 'next' | 'volume' | 'volume-off';
const PlaybackIcon = lazy(() => import('./DeferredPlaybackIcon'));

const icons: Partial<Record<IconName, LucideIcon>> = {
  account: CircleUserRound,
  'arrow-left': ArrowLeft,
  'arrow-right': ArrowRight,
  brand: Disc3,
  check: Check,
  home: House,
  language: Globe2,
  library: Library,
  lock: LockKeyhole,
  search: Search,
};

/** Centralizes the mature Lucide icon set used by shell controls. */
export const Icon = ({ name, ...props }: { name: IconName } & LucideProps) => {
  const Component = icons[name];
  const filledTransport = ['play', 'pause', 'previous', 'next'].includes(name);
  const properties: LucideProps = { 'aria-hidden': true, fill: filledTransport ? 'currentColor' : 'none',
    focusable: 'false', strokeWidth: 1.9, ...props };
  if (Component) return <Component {...properties} />;
  const { size = 24, absoluteStrokeWidth: _absoluteStrokeWidth, ...placeholder } = properties;
  // Playback controls already load on demand; their glyphs reserve the same box while their chunk arrives.
  return <Suspense fallback={<svg xmlns="http://www.w3.org/2000/svg" width={size} height={size}
    viewBox="0 0 24 24" stroke="currentColor" {...placeholder} />}>
    <PlaybackIcon {...properties} name={name as PlaybackIconName} />
  </Suspense>;
};
