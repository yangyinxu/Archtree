/**
 * The pure reading of an existing-Album review run's timeline (the server's lookupTimelineView.ts) that LookupProgress.tsx
 * renders: the names its title searches sent, its record, and how long a running run has gone without a step. It imports types
 * only, so the lazy step list carries none of the summary's modules.
 */
import type { ReviewLookupView } from './importLookupApi';

type Timeline = NonNullable<ReviewLookupView['timeline']>;
type Step = Timeline['steps'][number];
const SEARCHES: readonly string[] = ['albumArtist', 'album', 'songArtist', 'song'];
/** Whether a step is a search by the Album or song name, with or without an Artist name. */
export const titleSearch = (step: Step) => SEARCHES.includes(step.kind);
/**
 * The texts of the title searches a run sent whose text is shown, in order, for "This lookup searched for …"; a search the run may
 * not have sent (`unconfirmed`) is never named.
 */
export const searchedTexts = (timeline: Timeline) => timeline.steps.filter(step => titleSearch(step) && step.state === 'done' && step.texts?.length).map(step => step.texts![0]);
/**
 * A run's record, or null without a timeline: how long it took (whole minutes and seconds from its start to its end, else its
 * last step, never below zero), the searches its steps show as sent (the title searches done, the Track titles shown in a done
 * row once they were sent, and the iTunes searches its iTunes step counts as done; none the run may not have sent) and the
 * releases it found (as the chooser counts them). The bridge's checks on MusicBrainz are not searches by the run's own names, so
 * its step counts them on its own.
 */
export function lookupRecord(lookup: ReviewLookupView): { minutes: number; seconds: number; searches: number; releases: number } | null {
  const timeline = lookup.timeline;
  if (!timeline) return null;
  const sent = timeline.trackTitleSearch?.state === 'sent';
  const total = Math.floor(Math.max(0, Date.parse(timeline.completedAt ?? timeline.updatedAt) - Date.parse(timeline.startedAt)) / 1000) || 0;
  return { minutes: Math.floor(total / 60), seconds: total % 60, releases: lookup.candidates.length,
    searches: timeline.steps.reduce((sum, step) => sum + (step.kind === 'itunes' ? step.done ?? 0 : step.state !== 'done' ? 0 : titleSearch(step) ? 1
      : step.kind === 'trackTitle' && sent ? step.texts?.length ?? 0 : 0), 0) };
}
/**
 * Whole seconds a running run has gone without a step when more than five (it waits for its source); null otherwise or while
 * queued or retrying. Both times are the client's: `seenAt` is when this page first saw the run's current last step, so a client
 * clock ahead of or behind the server's never shows or hides the wait.
 */
export const gateWaitSeconds = (lookup: ReviewLookupView, now: number, seenAt: number): number | null =>
  lookup.state === 'running' && lookup.timeline && now - seenAt > 5_000 ? Math.floor((now - seenAt) / 1000) : null;
