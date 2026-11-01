import type { LocalizationContextValue } from '../../localization/LocalizationProvider';

/** Parses an `m:ss` or `h:mm:ss` duration into seconds; null when it is missing or malformed. */
export const durationSeconds = (duration: string | null) => {
  if (!duration) return null;
  const parts = duration.split(':').map(Number);
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !Number.isFinite(part) || part < 0)) {
    return null;
  }
  return parts.reduce((total, part) => total * 60 + part, 0);
};

/** Sums MediaTrack durations; null when any duration is unknown, so a partial total never shows. */
export const totalDurationSeconds = (tracks: readonly { duration: string | null }[]) => tracks
  .reduce<number | null>((total, track) => {
    const seconds = durationSeconds(track.duration);
    return seconds === null || total === null ? null : total + seconds;
  }, 0);

/** Formats a total as "1 hr 12 min" or "N min", never below 1 min. */
export const formatTotalDuration = (seconds: number, t: LocalizationContextValue['t']) => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0
    ? t('playlist.duration.hours', { hours, minutes })
    : t('playlist.duration.minutes', { minutes: Math.max(1, minutes) });
};
