import {
  ArrowLeft,
  ArrowRight,
  CirclePause,
  CirclePlay,
  CircleUserRound,
  House,
  Library,
  LockKeyhole,
  Search,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  type LucideIcon,
  type LucideProps
} from 'lucide-react';

export type IconName =
  | 'account'
  | 'arrow-left'
  | 'arrow-right'
  | 'home'
  | 'library'
  | 'lock'
  | 'pause'
  | 'play'
  | 'previous'
  | 'search'
  | 'next'
  | 'volume'
  | 'volume-off';

const icons: Record<IconName, LucideIcon> = {
  account: CircleUserRound,
  'arrow-left': ArrowLeft,
  'arrow-right': ArrowRight,
  home: House,
  library: Library,
  lock: LockKeyhole,
  pause: CirclePause,
  play: CirclePlay,
  previous: SkipBack,
  search: Search,
  next: SkipForward,
  volume: Volume2,
  'volume-off': VolumeX
};

/** Centralizes the mature Lucide icon set used by shell controls. */
export const Icon = ({ name, ...props }: { name: IconName } & LucideProps) => {
  const Component = icons[name];
  return <Component aria-hidden="true" focusable="false" strokeWidth={1.8} {...props} />;
};
