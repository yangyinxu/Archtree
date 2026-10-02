import {
  Maximize2, PanelRight, Pause, Play, Repeat1, Repeat2, Shuffle,
  SkipBack, SkipForward, Volume2, VolumeX, type LucideIcon, type LucideProps
} from 'lucide-react';
import type { PlaybackIconName } from './Icon';

const icons: Record<PlaybackIconName, LucideIcon> = {
  expand: Maximize2, 'panel-right': PanelRight, pause: Pause, play: Play, previous: SkipBack,
  repeat: Repeat2, 'repeat-one': Repeat1, shuffle: Shuffle, next: SkipForward, volume: Volume2, 'volume-off': VolumeX
};

/** Defers playback glyph bytes while preserving the shared Icon props and SVG renderer. */
export default function DeferredPlaybackIcon({ name, ...props }: { name: PlaybackIconName } & LucideProps) {
  const Component = icons[name];
  return <Component {...props} />;
}
