import {
  ArrowLeft,
  ArrowRight,
  CircleUserRound,
  House,
  Library,
  LockKeyhole,
  Pause,
  Play,
  Repeat1,
  Repeat2,
  Search,
  Shuffle,
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
  | 'repeat'
  | 'repeat-one'
  | 'search'
  | 'shuffle'
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
  pause: Pause,
  play: Play,
  previous: SkipBack,
  repeat: Repeat2,
  'repeat-one': Repeat1,
  search: Search,
  shuffle: Shuffle,
  next: SkipForward,
  volume: Volume2,
  'volume-off': VolumeX
};

/** Centralizes the mature Lucide icon set used by shell controls. */
export const Icon = ({ name, ...props }: { name: IconName } & LucideProps) => {
  const Component = icons[name];
  const filledTransport = ['play', 'previous', 'next'].includes(name);
  return (
    <Component
      aria-hidden="true"
      fill={filledTransport ? 'currentColor' : 'none'}
      focusable="false"
      strokeWidth={name === 'pause' ? 2.8 : 1.9}
      {...props}
    />
  );
};
