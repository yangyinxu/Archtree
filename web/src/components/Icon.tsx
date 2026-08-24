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
  Maximize2,
  PanelRight,
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

const icons: Record<IconName, LucideIcon> = {
  account: CircleUserRound,
  'arrow-left': ArrowLeft,
  'arrow-right': ArrowRight,
  brand: Disc3,
  check: Check,
  expand: Maximize2,
  home: House,
  language: Globe2,
  library: Library,
  lock: LockKeyhole,
  pause: Pause,
  'panel-right': PanelRight,
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
  const filledTransport = ['play', 'pause', 'previous', 'next'].includes(name);
  return (
    <Component
      aria-hidden="true"
      fill={filledTransport ? 'currentColor' : 'none'}
      focusable="false"
      strokeWidth={1.9}
      {...props}
    />
  );
};
