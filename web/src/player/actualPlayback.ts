import type { PlayerPlaybackEvent, PlayerStore } from './types';

/** A source stays fixed across resumes; each proven run has its own occurrence. Times are monotonic. */
export interface ActualPlaybackSample {
  intentId: number;
  sourceId: string;
  occurrenceId: string;
  mediaTrackId: string;
  positionMs: number;
  observedAtMs: number;
  room: { roomId: string; epoch: number; playbackEpoch: number; entryId: string; mediaRevision: string } | null;
}
export type ActualPlaybackObservation = { type: 'intent'; intentId: number }
  | { type: 'playing' | 'progress'; sample: ActualPlaybackSample }
  | { type: 'stopped'; occurrenceId: string | null };

// Observers can remount after a transient privacy/read barrier; their new gestures must supersede earlier claims.
const intentClocks = new WeakMap<PlayerStore, { value: number; event?: PlayerPlaybackEvent }>();

/** Lazy consumers get actual source-matched playback, never optimistic UI status or a resolved play promise. */
export const createActualPlaybackObserver = (store: PlayerStore, listener: (event: ActualPlaybackObservation) => void,
  options: { now?: () => number; document?: Document | null; window?: Window | null } = {}) => {
  const now = options.now ?? (() => performance.now());
  const visibility = options.document === undefined ? typeof document === 'undefined' ? null : document : options.document;
  const lifecycle = options.window === undefined ? typeof window === 'undefined' ? null : window : options.window;
  const sourceNamespace = crypto.randomUUID();
  const intentClock = intentClocks.get(store) ?? { value: 0 };
  intentClocks.set(store, intentClock);
  let intentId = 0;
  let key = '';
  let actual: ActualPlaybackSample | null = null;
  let proven = false;
  let baseline = 0;
  let suspended = false;
  let recovery: { key: string; baseline: number | null } | null = null;
  const playbackKey = (event: PlayerPlaybackEvent) => `${event.sourceGeneration}:${event.item?.id}:${event.room?.roomId}:${event.room?.epoch}:${event.room?.playbackEpoch}:${event.room?.currentEntryId}`;
  const send = (event: ActualPlaybackObservation) => { try { listener(event); } catch { /* Observations never affect transport. */ } };
  const stop = (forgetProof = false) => {
    const occurrenceId = actual?.occurrenceId ?? null;
    actual = null;
    if (recovery) recovery.baseline = null;
    if (forgetProof) proven = false;
    if (occurrenceId) send({ type: 'stopped', occurrenceId });
  };
  const absolute = (url: string) => {
    try { return new URL(url, typeof location === 'undefined' ? 'http://localhost' : location.href).href; }
    catch { return ''; }
  };
  const usable = (event: PlayerPlaybackEvent) => {
    const { media, item, room } = event;
    if (!media || !item || item.mediaType !== 'audio' || media.paused || media.ended || media.error
      || media.seeking || (media.readyState ?? 0) < 3 || !Number.isFinite(media.currentTime) || media.currentTime < 0
      || media.currentTime > 86_400 || !media.currentSrc || !item.streamUrl
      || absolute(media.src) !== absolute(item.streamUrl) || absolute(media.currentSrc) !== absolute(item.streamUrl)) return false;
    return !room || room.status === 'playing' && room.playbackAllowed !== false && now() >= room.anchorMonotonicMs
      && room.queue[room.entryIds.indexOf(room.currentEntryId)]?.id === item.id;
  };
  const accept = (event: PlayerPlaybackEvent, type: 'playing' | 'progress') => {
    const room = event.room;
    const sample: ActualPlaybackSample = { intentId, sourceId: `${sourceNamespace}_${event.sourceGeneration}`,
      occurrenceId: actual?.occurrenceId ?? crypto.randomUUID(), mediaTrackId: event.item!.id,
      positionMs: Math.round(event.media!.currentTime * 1000), observedAtMs: now(),
      room: room ? { roomId: room.roomId, epoch: room.epoch, playbackEpoch: room.playbackEpoch,
        entryId: room.currentEntryId, mediaRevision: room.mediaRevision } : null };
    actual = sample; baseline = event.media!.currentTime; proven = true; recovery = null;
    send({ type, sample });
  };
  const unsubscribe = store.subscribePlaybackEvents(event => {
    if (event.type === 'intent') {
      if (intentClock.event !== event) { intentClock.event = event; intentClock.value++; }
      if (!proven) recovery = { key: playbackKey(event), baseline: null };
      intentId = intentClock.value; send({ type: 'intent', intentId }); return;
    }
    if (event.type === 'sourcechange') { stop(true); key = ''; recovery = null; return; }
    const currentKey = playbackKey(event);
    if (currentKey !== key) { stop(true); key = currentKey; baseline = event.media?.currentTime ?? 0; }
    if (recovery?.key !== currentKey) recovery = null;
    if (['pause', 'waiting', 'stalled', 'seeking', 'ended', 'error', 'emptied', 'loadstart'].includes(event.type)) {
      baseline = event.media?.currentTime ?? 0;
      stop(['error', 'emptied', 'loadstart', 'ended'].includes(event.type));
      return;
    }
    if (event.type === 'seeked') { baseline = event.media?.currentTime ?? 0; return; }
    if (suspended || !usable(event)) {
      if (event.type === 'playing' || event.type === 'timeupdate') stop();
      return;
    }
    if (event.type === 'playing') { if (!actual) accept(event, 'playing'); return; }
    if (event.type === 'timeupdate' && !proven && recovery) {
      // Remounts can miss playing. A new gesture plus two fresh native observations can prove continuing Audio.
      if (recovery.baseline !== null && event.media!.currentTime > recovery.baseline + 0.001) accept(event, 'playing');
      else recovery.baseline = event.media!.currentTime;
      return;
    }
    if (event.type === 'timeupdate' && proven && event.media!.currentTime > baseline + 0.001) {
      // A seek/buffering recovery needs fresh advancing media time from a source already proven by playing.
      accept(event, actual ? 'progress' : 'playing');
    }
  });
  const suspend = () => { suspended = true; stop(); };
  const resume = () => { suspended = false; };
  visibility?.addEventListener('freeze', suspend);
  visibility?.addEventListener('resume', resume);
  lifecycle?.addEventListener('pagehide', suspend);
  lifecycle?.addEventListener('pageshow', resume);
  return () => {
    stop(true); unsubscribe();
    visibility?.removeEventListener('freeze', suspend);
    visibility?.removeEventListener('resume', resume);
    lifecycle?.removeEventListener('pagehide', suspend);
    lifecycle?.removeEventListener('pageshow', resume);
  };
};
