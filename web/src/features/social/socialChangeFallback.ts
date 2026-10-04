import { getSocialChangeRevision } from '../../api/socialChanges';

/**
 * The first poll waits for one room-session heartbeat, then polls every 15 seconds (the former
 * fixed share-list cadence). Each unchanged or failed poll doubles the wait up to one minute, so
 * an idle tab settles at one request per minute.
 */
export const socialChangePollMs = { base: 15_000, maximum: 60_000 } as const;

/**
 * HTTP stand-in for the room socket's payload-free `socialChanged` signal, so friend requests
 * and shares still arrive while rooms are disabled or the socket is connecting or lost.
 *
 * The room session calls `tick` on each heartbeat only while no live socket is connected, so a
 * connected socket never causes duplicate polling. Ticks poll only in a visible tab. The first
 * poll always reports a change, like a fresh socket subscription, because something may have
 * changed after the first reads and before this fallback began. The last revision survives
 * connected periods, so the first poll after a socket loss reports only real changes.
 */
export const createSocialChangeFallback = (viewerId: string, active: () => boolean, changed: () => void) => {
  let revision: number | undefined;
  let delay: number = socialChangePollMs.base;
  let dueAt = 0;
  let hidden = false;
  let polling = false;
  return {
    async tick() {
      if (!active() || polling) return;
      if (document.hidden) { hidden = true; return; }
      // Returning to a visible tab polls at the next heartbeat instead of finishing an idle backoff.
      if (hidden) { hidden = false; delay = socialChangePollMs.base; dueAt = 0; }
      if (performance.now() < dueAt) return;
      polling = true;
      try {
        const next = (await getSocialChangeRevision(viewerId)).revision;
        if (!active()) return;
        const different = next !== revision;
        revision = next;
        delay = different ? socialChangePollMs.base : Math.min(socialChangePollMs.maximum, delay * 2);
        if (different) changed();
      } catch {
        // Failures and rate limits back off like an unchanged poll and never refresh lists.
        delay = Math.min(socialChangePollMs.maximum, delay * 2);
      } finally {
        polling = false;
        dueAt = performance.now() + delay;
      }
    }
  };
};
