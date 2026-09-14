import { copyQueue } from './queueOrder';
import type { PlayerAudio, PlayerQueueItem } from './types';

/** Validated room state translated to the existing player's local monotonic clock. */
export interface RoomPlaybackState {
  readonly roomId: string;
  readonly epoch: number;
  readonly mediaRevision: string;
  readonly revision: number;
  readonly playbackEpoch: number;
  readonly controlEpoch: number;
  readonly queueRevision: number;
  /** Presentation state only; the server independently authorizes every intent. */
  readonly canControl: boolean;
  /** A room member must confirm readiness before this device may follow a playing timeline. */
  readonly playbackAllowed?: boolean;
  readonly entryIds: readonly string[];
  readonly queue: readonly PlayerQueueItem[];
  readonly currentEntryId: string;
  readonly positionSeconds: number;
  readonly status: 'preparing' | 'playing' | 'paused' | 'ended';
  /** A server anchor must first be translated to this device's monotonic clock. */
  readonly anchorMonotonicMs: number;
}

export type RoomPlaybackAction =
  | { readonly type: 'play' | 'pause' | 'previous' | 'next' }
  | { readonly type: 'seek'; readonly positionSeconds: number }
  | { readonly type: 'select'; readonly entryId: string };

/** The expected state is copied at the user gesture; callers must never rebase it. */
export type RoomPlaybackIntent = RoomPlaybackAction & {
  readonly expectedRoomId: string;
  readonly expectedEpoch: number;
  readonly expectedEntryId: string;
  readonly expectedPlaybackEpoch: number;
  readonly expectedControlEpoch: number;
  readonly expectedQueueRevision: number;
};

/** Observations are diagnostics/readiness, never implicitly translated into user commands. */
export interface RoomPlaybackObservation {
  readonly type: 'ready' | 'seek-complete' | 'actual-start' | 'ended' | 'unsupported-rate' | 'unsupported-seek' | 'suspended';
  readonly entryId: string;
  readonly playbackEpoch: number;
  readonly positionSeconds: number;
  readonly monotonicMs: number;
}

export interface RoomPlaybackOptions {
  onIntent(intent: RoomPlaybackIntent): void;
  onObservation?(observation: RoomPlaybackObservation): void;
  now?: () => number;
  /** Hidden documents suspend locally until explicit resync. */
  visibility?: Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'> | null;
}

/** Local pause survives every remote state; detach pauses and never restores an old queue. */
export interface RoomPlaybackAttachment {
  apply(state: RoomPlaybackState): Promise<boolean>;
  select(entryId: string): boolean;
  pauseLocally(): void;
  resync(): Promise<void>;
  correct(positionSeconds: number): 'rate' | 'seek' | 'none';
  detach(): void;
}

/** The adapter delegates all media writes to the already-owned player element. */
export interface RoomPlaybackPort {
  media(): PlayerAudio | null;
  sourceGeneration(): number;
  install(queue: readonly PlayerQueueItem[], index: number): Promise<void>;
  updateQueue(queue: readonly PlayerQueueItem[], index: number): void;
  play(): Promise<void>;
  pause(): void;
  seek(position: number): boolean;
  detach(): void;
}

const finiteNonnegative = (value: number) => Number.isFinite(value) && value >= 0;

/** Separates confirmed-state application from explicit gestures and fences delayed media work. */
export const createRoomPlaybackController = (port: RoomPlaybackPort, options: RoomPlaybackOptions) => {
  const now = options.now ?? (() => performance.now());
  let state: RoomPlaybackState | null = null;
  let detached = false;
  let localPaused = false;
  let effect = 0;
  let source = -1;
  let scheduled: ReturnType<typeof setTimeout> | undefined;
  let correction: ReturnType<typeof setTimeout> | undefined;
  let needsSeek = true;
  let seekPending = false;
  let seekTarget = 0;
  let seekFailed = false;
  let playRequested = false;
  const observed = new Set<string>();

  const report = (type: RoomPlaybackObservation['type']) => {
    if (!state || detached) return;
    const key = `${effect}:${type}`;
    if (observed.has(key)) return;
    observed.add(key);
    try {
      options.onObservation?.(Object.freeze({
        type, entryId: state.currentEntryId, playbackEpoch: state.playbackEpoch,
        positionSeconds: port.media()?.currentTime ?? 0, monotonicMs: now()
      }));
    } catch {
      // Optional observation collection cannot change local playback or create retries.
    }
  };

  const resetRate = () => {
    const target = port.media();
    if (!target) return;
    try { target.playbackRate = 1; } catch { /* Unsupported rate remains an explicit fallback. */ }
  };

  const cancelEffects = () => {
    effect += 1;
    clearTimeout(scheduled);
    clearTimeout(correction);
    scheduled = undefined;
    correction = undefined;
    playRequested = false;
    observed.clear();
    resetRate();
  };

  const matchesSource = (target: PlayerAudio) => {
    if (!state || detached || source !== port.sourceGeneration()) return false;
    const item = state.queue[state.entryIds.indexOf(state.currentEntryId)];
    if (!item) return false;
    const absolute = (url: string) => {
      try { return new URL(url, typeof location === 'undefined' ? 'http://localhost' : location.href).href; }
      catch { return url; }
    };
    return absolute(target.src) === absolute(item.streamUrl)
      && (!target.currentSrc || absolute(target.currentSrc) === absolute(item.streamUrl));
  };

  const desiredPosition = () => state === null ? 0 : state.positionSeconds + (
    state.status === 'playing' ? Math.max(0, now() - state.anchorMonotonicMs) / 1000 : 0
  );

  /** Readiness requires real metadata, a completed seek, and enough decoded data to start. */
  const reconcile = async (): Promise<void> => {
    const target = port.media();
    if (!state || !target || !matchesSource(target) || seekFailed) return;
    if ((target.readyState ?? 0) < 1 || !finiteNonnegative(target.duration) || target.duration <= 0) return;
    if (needsSeek) {
      needsSeek = false;
      seekPending = true;
      seekTarget = Math.min(desiredPosition(), target.duration);
      if (!port.seek(seekTarget)) {
        needsSeek = true;
        seekPending = false;
        return;
      }
      seekPending = target.seeking ?? false;
      if (!seekPending && Math.abs(target.currentTime - seekTarget) > 0.15) {
        seekFailed = true;
        report('unsupported-seek');
        return;
      }
      if (!seekPending) report('seek-complete');
    }
    if (seekPending || target.seeking || (target.readyState ?? 0) < 3) return;
    report('ready');
    if (localPaused || state.playbackAllowed === false || state.status !== 'playing') {
      port.pause();
      return;
    }
    const remaining = state.anchorMonotonicMs - now();
    if (remaining > 0) {
      if (scheduled !== undefined) return;
      const expectedEffect = effect;
      scheduled = setTimeout(() => {
        scheduled = undefined;
        if (!detached && effect === expectedEffect) {
          // A delayed foreground timer should seek once to the current anchor before starting.
          if (state && now() - state.anchorMonotonicMs > 150) needsSeek = true;
          void reconcile();
        }
      }, remaining);
      return;
    }
    if (playRequested || (!target.paused && !target.ended)) return;
    playRequested = true;
    await port.play();
  };

  const intent = (action: RoomPlaybackAction): boolean => {
    if (!state || detached || !state.canControl) return false;
    if (action.type === 'select' && !state.entryIds.includes(action.entryId)) return false;
    if (action.type === 'seek' && !finiteNonnegative(action.positionSeconds)) return false;
    options.onIntent(Object.freeze({ ...action,
      expectedRoomId: state.roomId,
      expectedEpoch: state.epoch,
      expectedEntryId: state.currentEntryId,
      expectedPlaybackEpoch: state.playbackEpoch,
      expectedControlEpoch: state.controlEpoch,
      expectedQueueRevision: state.queueRevision
    }));
    return true;
  };

  const attachment: RoomPlaybackAttachment = {
    async apply(incoming) {
      if (detached || (state && incoming.revision <= state.revision)) return false;
      if (!incoming.roomId || !incoming.mediaRevision || !Number.isSafeInteger(incoming.epoch) || incoming.epoch < 1 || (state && (
        incoming.roomId !== state.roomId || incoming.epoch !== state.epoch
      ))) return false;
      if (![incoming.revision, incoming.playbackEpoch, incoming.controlEpoch, incoming.queueRevision]
        .every((value) => Number.isSafeInteger(value) && value > 0)
        || !finiteNonnegative(incoming.positionSeconds) || !finiteNonnegative(incoming.anchorMonotonicMs)
        || typeof incoming.canControl !== 'boolean'
        || (incoming.playbackAllowed !== undefined && typeof incoming.playbackAllowed !== 'boolean')
        || !['preparing', 'playing', 'paused', 'ended'].includes(incoming.status)
        || incoming.queue.length < 1 || incoming.queue.length > 100
        || incoming.entryIds.length !== incoming.queue.length
        || incoming.entryIds.some((id) => typeof id !== 'string' || !id)
        || new Set(incoming.entryIds).size !== incoming.entryIds.length
        || !incoming.entryIds.includes(incoming.currentEntryId)) return false;
      const previous = state;
      if (previous && (incoming.playbackEpoch < previous.playbackEpoch
        || incoming.controlEpoch < previous.controlEpoch
        || incoming.queueRevision < previous.queueRevision)) return false;
      const previousIndex = previous?.entryIds.indexOf(previous.currentEntryId) ?? -1;
      const incomingItem = incoming.queue[incoming.entryIds.indexOf(incoming.currentEntryId)];
      const preparationCompleted = previous?.status === 'preparing' && ['playing', 'paused'].includes(incoming.status);
      if (previous && incoming.playbackEpoch === previous.playbackEpoch && (
        incoming.currentEntryId !== previous.currentEntryId || incoming.mediaRevision !== previous.mediaRevision
        || incomingItem.id !== previous.queue[previousIndex].id
        || incomingItem.streamUrl !== previous.queue[previousIndex].streamUrl
        || incomingItem.mediaType !== previous.queue[previousIndex].mediaType
        || incoming.positionSeconds !== previous.positionSeconds
        || (!preparationCompleted && (incoming.anchorMonotonicMs !== previous.anchorMonotonicMs || incoming.status !== previous.status))
      )) return false;
      state = Object.freeze({ ...incoming, entryIds: Object.freeze([...incoming.entryIds]), queue: copyQueue(incoming.queue) });
      const index = state.entryIds.indexOf(state.currentEntryId);
      const sourceChanged = !previous || previous.currentEntryId !== state.currentEntryId
        || previous.mediaRevision !== state.mediaRevision
        || previous.queue[previousIndex]?.streamUrl !== state.queue[index].streamUrl;
      const timelineChanged = sourceChanged || previous?.playbackEpoch !== state.playbackEpoch || preparationCompleted
        || previous?.playbackAllowed !== state.playbackAllowed;
      if (!sourceChanged) port.updateQueue(state.queue, index);
      if (!timelineChanged) return true; // Membership/control-only revisions cannot reload or restart media.
      cancelEffects();
      needsSeek = true;
      seekPending = false;
      seekFailed = false;
      port.pause();
      const expectedEffect = effect;
      if (sourceChanged) await port.install(state.queue, index);
      if (detached || effect !== expectedEffect) return true;
      source = port.sourceGeneration();
      await reconcile();
      return true;
    },
    select: (entryId) => intent({ type: 'select', entryId }),
    pauseLocally() {
      if (detached) return;
      localPaused = true;
      cancelEffects();
      port.pause();
    },
    async resync() {
      if (detached) return;
      if (visibility?.hidden) return;
      localPaused = false;
      cancelEffects();
      needsSeek = true;
      seekPending = false;
      seekFailed = false;
      port.pause();
      await reconcile();
    },
    correct(positionSeconds) {
      const target = port.media();
      if (!state || !target || detached || localPaused || !matchesSource(target)
        || state.status !== 'playing' || state.playbackAllowed === false || !playRequested || target.paused
        || needsSeek || seekPending || seekFailed || target.seeking
        || !finiteNonnegative(positionSeconds) || (target.readyState ?? 0) < 3) return 'none';
      const drift = positionSeconds - target.currentTime;
      clearTimeout(correction);
      resetRate();
      if (Math.abs(drift) <= 0.15) return 'none';
      const expectedEffect = effect;
      const correctionStart = now();
      if (state.status === 'playing' && !target.paused && Math.abs(drift) <= 0.35) {
        const rate = drift > 0 ? 1.05 : 0.95;
        try {
          target.playbackRate = rate;
          if (Math.abs(target.playbackRate - rate) > 0.001) throw new Error('Rate rejected');
          correction = setTimeout(() => {
            if (detached || effect !== expectedEffect || !matchesSource(target) || target.seeking || target.paused) return;
            resetRate();
            const expected = positionSeconds + (now() - correctionStart) / 1000;
            if (Math.abs(expected - target.currentTime) > 0.15) port.seek(Math.min(expected, target.duration));
          }, 4000);
          return 'rate';
        } catch { report('unsupported-rate'); }
      }
      return port.seek(Math.min(positionSeconds, target.duration)) ? 'seek' : 'none';
    },
    detach() {
      if (detached) return;
      detached = true;
      visibility?.removeEventListener('visibilitychange', onVisibilityChange);
      cancelEffects();
      port.pause();
      port.detach();
    }
  };

  const visibility = options.visibility === undefined
    ? typeof document === 'undefined' ? null : document
    : options.visibility;
  const onVisibilityChange = () => {
    if (!visibility?.hidden || detached) return;
    attachment.pauseLocally();
    report('suspended');
  };
  visibility?.addEventListener('visibilitychange', onVisibilityChange);
  if (visibility?.hidden) localPaused = true;

  return {
    attachment,
    intent,
    /** DOM callbacks never infer user intent, including callbacks produced by remote writes. */
    observe(event: string, target: PlayerAudio): boolean {
      if (!matchesSource(target)) return event === 'volumechange';
      if (event === 'play' || event === 'playing') {
        if (localPaused || state?.playbackAllowed === false || !playRequested || needsSeek || seekPending || seekFailed || target.seeking
          || state?.status !== 'playing' || now() < state.anchorMonotonicMs) {
          port.pause();
          return false;
        }
        if (event === 'playing' && !target.paused && (target.readyState ?? 0) >= 3) report('actual-start');
        return event === 'playing' && !target.paused;
      }
      if (event === 'ended') {
        if (target.ended && (target.readyState ?? 0) >= 2 && !seekPending) report('ended');
        return target.ended; // The store records completion without advancing its room queue.
      }
      if (event === 'pause' && !target.paused) return false;
      if (event === 'error' && !target.error) return false;
      if (event === 'seeked' && !target.seeking) {
        if (seekPending && Math.abs(target.currentTime - seekTarget) > 0.15) {
          seekFailed = true;
          seekPending = false;
          report('unsupported-seek');
          return false;
        }
        seekPending = false;
        report('seek-complete');
      }
      if (['loadedmetadata', 'canplay', 'seeked'].includes(event)) void reconcile();
      return true;
    }
  };
};
