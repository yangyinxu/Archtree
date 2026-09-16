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

/** Gesture state is never rebased; Play without shared permission requests personal readiness only. */
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
  /** Hidden Audio can keep following the room; other media require a visible document. */
  visibility?: Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'> | null;
  /** Page departure suspends playback even when the browser permits background Audio. */
  pageLifecycle?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> | null;
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
  let decoderRecovery: ReturnType<typeof setTimeout> | undefined;
  let recoveredOccurrence: string | null = null;
  let reloadingOccurrence: string | null = null;
  let rateFallbackOccurrence: string | null = null;
  let needsSeek = true;
  let seekPending = false;
  let seekTarget = 0;
  let seekFailed = false;
  let playRequested = false;
  let firstProgress: { position: number; monotonicMs: number; seeking: boolean } | undefined;
  // The dispatch clock measures seek cost; seeked only establishes a separate proof-of-progress baseline.
  let postSeek: { occurrence: string; effect: number; source: number; target: number; dispatchedAt: number;
    referencePosition: number; referenceAt: number; baselinePosition: number; baselineAt: number;
    expiresAt: number; completed: boolean; accepted: boolean } | undefined;
  let postSeekExpiry: ReturnType<typeof setTimeout> | undefined;
  let seekLatency: number | undefined;
  let convergenceBudget: { occurrence: string; attempts: number; startedAt: number } | undefined;
  let latestCorrection: { position: number; monotonicMs: number } | undefined;
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
    try { if (target.playbackRate !== 1) target.playbackRate = 1; } catch { /* Unsupported rate remains an explicit fallback. */ }
  };

  const clearPostSeek = () => {
    clearTimeout(postSeekExpiry);
    postSeekExpiry = undefined;
    postSeek = undefined;
  };

  const cancelEffects = () => {
    effect += 1;
    clearTimeout(scheduled);
    clearTimeout(correction);
    clearTimeout(decoderRecovery);
    scheduled = undefined;
    correction = undefined;
    decoderRecovery = undefined;
    playRequested = false;
    firstProgress = undefined;
    clearPostSeek();
    seekLatency = undefined;
    latestCorrection = undefined;
    observed.clear();
    resetRate();
  };

  const matchesSource = (target: PlayerAudio) => {
    if (!state || detached || source !== port.sourceGeneration()) return false;
    if (reloadingOccurrence !== null && reloadingOccurrence === occurrence()) return false;
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

  const correctionAllowed = (target: PlayerAudio) => Boolean(state && !detached && !localPaused && matchesSource(target)
    && state.status === 'playing' && state.playbackAllowed !== false && playRequested && !target.paused
    && !target.error && !target.ended && !needsSeek && !seekPending && !seekFailed && !target.seeking && (target.readyState ?? 0) >= 3);

  /** Serializes seek measurement and preserves its unmodified authoritative clock separately from predictive lead. */
  const correctionSeek = (target: PlayerAudio, position: number, automatic = false) => {
    const key = occurrence();
    if (!key || postSeek) return false;
    const lead = seekLatency ?? 0;
    const destination = Math.min(position + (position + lead < target.duration - 0.35 ? lead : 0), target.duration);
    const dispatchedAt = now();
    const expiresAt = automatic && convergenceBudget
      ? Math.min(dispatchedAt + 3000, convergenceBudget.startedAt + 6000) : dispatchedAt + 3000;
    const pending = { occurrence: key, effect, source, target: destination, dispatchedAt,
      referencePosition: position, referenceAt: dispatchedAt, baselinePosition: destination, baselineAt: dispatchedAt,
      expiresAt, completed: false, accepted: false };
    const startup = firstProgress;
    firstProgress = undefined; // A correction owns startup convergence; its timeupdate cannot also run the original latch.
    postSeek = pending;
    const accepted = port.seek(destination);
    if (postSeek === pending) {
      pending.accepted = accepted;
      if (!accepted) { clearPostSeek(); firstProgress = startup; }
      else postSeekExpiry = setTimeout(() => {
        if (postSeek !== pending) return;
        clearPostSeek();
        seekLatency = undefined;
      }, Math.max(0, expiresAt - now()));
    }
    return accepted;
  };

  // Logical identity survives decoder reinstalls; physical source generations only fence in-flight work.
  const occurrence = () => state && JSON.stringify([state.roomId, state.epoch, state.currentEntryId, state.mediaRevision, state.playbackEpoch]);
  const currentPostSeek = () => postSeek && postSeek.effect === effect && postSeek.source === source
    && source === port.sourceGeneration() && postSeek.occurrence === occurrence();

  const expirePostSeek = () => {
    if (!postSeek || now() < postSeek.expiresAt) return false;
    clearPostSeek(); seekLatency = undefined;
    return true;
  };

  /** Two measured follow-ups accommodate changing decoder cost; the occurrence budget survives effect cancellation. */
  const observePostSeekProgress = (target: PlayerAudio) => {
    if (expirePostSeek()) return;
    const pending = postSeek;
    if (!pending || !pending.accepted || !pending.completed || !currentPostSeek() || !correctionAllowed(target)) return;
    const elapsed = (now() - pending.baselineAt) / 1000;
    const advanced = target.currentTime - pending.baselinePosition;
    if (elapsed === 0 && advanced === 0) return;
    if (!finiteNonnegative(target.currentTime) || target.ended || target.error
      || Math.abs((target.playbackRate ?? 1) - 1) > 0.001 || elapsed <= 0 || advanced < 0 || advanced > elapsed + 0.05) {
      clearPostSeek(); seekLatency = undefined; return;
    }
    if (advanced <= 0.02) return;
    const latency = Math.max(0, (now() - pending.dispatchedAt) / 1000 - (target.currentTime - pending.target));
    const position = pending.referencePosition + (now() - pending.referenceAt) / 1000;
    clearPostSeek();
    if (!finiteNonnegative(latency) || latency > 2) { seekLatency = undefined; return; }
    seekLatency = latency;
    if (Math.abs(position - target.currentTime) <= 0.35
      || !finiteNonnegative(target.duration) || position + latency >= target.duration - 0.35) return;
    if (convergenceBudget?.occurrence !== pending.occurrence) {
      convergenceBudget = { occurrence: pending.occurrence, attempts: 0, startedAt: now() };
    }
    if (convergenceBudget.attempts >= 2 || now() - convergenceBudget.startedAt >= 6000) return;
    convergenceBudget.attempts += 1; // Consume before the write, including rejected or synchronously cancelled seeks.
    correctionSeek(target, position, true);
  };
  /** Excludes loading, failed, deliberately paused, and end-of-media states from automatic repair. */
  const stalledDecoder = (target: PlayerAudio) => {
    if (!state || localPaused || !matchesSource(target) || state.status === 'ended'
      || state.queue[state.entryIds.indexOf(state.currentEntryId)].mediaType !== 'audio'
      || !target.paused || target.seeking || seekPending || needsSeek || seekFailed || target.error
      || target.readyState !== 2 || !finiteNonnegative(target.currentTime) || !finiteNonnegative(target.duration)
      || target.currentTime >= target.duration - 0.35) return false;
    try {
      const buffered = target.buffered;
      return buffered?.length === 1 && buffered.start(0) <= 0.001 && buffered.end(0) >= target.duration - 0.001;
    } catch { return false; }
  };

  /** A fully downloaded paused decoder can stall after seeking; retry its source once, never manufacture readiness. */
  const recoverDecoder = (target: PlayerAudio) => {
    const key = occurrence();
    if (!key || decoderRecovery !== undefined || key === recoveredOccurrence || !stalledDecoder(target)) return;
    const expectedEffect = effect, expectedSource = source;
    decoderRecovery = setTimeout(() => {
      decoderRecovery = undefined;
      if (!state || detached || effect !== expectedEffect || source !== expectedSource || occurrence() !== key || !stalledDecoder(target)) return;
      recoveredOccurrence = key;
      reloadingOccurrence = key;
      cancelEffects();
      needsSeek = true;
      seekPending = false;
      port.pause();
      const recovering = state;
      void (async () => {
        try { await port.install(recovering.queue, recovering.entryIds.indexOf(recovering.currentEntryId)); }
        catch {
          // Keep the source fenced and unready after failure; never repeat this automatic reload.
          if (reloadingOccurrence === key) reloadingOccurrence = null;
          if (!detached && occurrence() === key) { source = port.sourceGeneration(); seekFailed = true; }
          return;
        }
        if (reloadingOccurrence === key) reloadingOccurrence = null;
        if (!detached && occurrence() === key) {
          source = port.sourceGeneration();
          // A decoder that required reload must avoid rate changes that can flush it through another implicit seek.
          rateFallbackOccurrence = key;
        }
        if (detached || localPaused || occurrence() !== key) return;
        // Same-occurrence snapshots may finish preparation during install; source effects were fenced until now.
        await reconcile(); // Use the latest authoritative anchor, including a cohort that started during reload.
      })();
    }, 1000);
  };

  /** Readiness requires real metadata, a completed seek, and enough decoded data to start. */
  const reconcile = async (): Promise<void> => {
    const target = port.media();
    if (!state || !target || !matchesSource(target) || seekFailed) return;
    if ((target.readyState ?? 0) < 1 || !finiteNonnegative(target.duration) || target.duration <= 0) return;
    if (needsSeek) {
      needsSeek = false;
      seekPending = true;
      seekTarget = Math.min(desiredPosition(), target.duration);
      // Reconfirming readiness must not flush a decoder that already completed this exact seek.
      const atTarget = !target.seeking && Math.abs(target.currentTime - seekTarget) <= 0.001;
      if (!atTarget && !port.seek(seekTarget)) {
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
    if (seekPending || target.seeking) return;
    if ((target.readyState ?? 0) < 3) { recoverDecoder(target); return; }
    clearTimeout(decoderRecovery);
    decoderRecovery = undefined;
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
    firstProgress = { position: target.currentTime, monotonicMs: now(), seeking: false };
    await port.play();
  };

  const intent = (action: RoomPlaybackAction): boolean => {
    if (!state || detached || (!state.canControl && action.type !== 'play')) return false;
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
      if (hiddenNonAudio()) suspend();
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
      const expectedPlaybackEpoch = state.playbackEpoch;
      if (sourceChanged) await port.install(state.queue, index);
      // Suspension cancels a start, but a later explicit resync still needs the installed source.
      if (!detached && state.playbackEpoch === expectedPlaybackEpoch) source = port.sourceGeneration();
      if (detached || effect !== expectedEffect) return true;
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
      if (hiddenNonAudio()) return;
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
      if (!state || !target || !finiteNonnegative(positionSeconds)) return 'none';
      expirePostSeek(); // Browser timer callbacks may be delayed behind a media event or heartbeat.
      if (postSeek) {
        if (currentPostSeek() && !detached && !localPaused && matchesSource(target)
          && state.status === 'playing' && state.playbackAllowed !== false && playRequested) {
          postSeek.referencePosition = positionSeconds;
          postSeek.referenceAt = now();
          latestCorrection = { position: positionSeconds, monotonicMs: now() };
          return 'none'; // Pings refine the authoritative clock while the decoder finishes the sole in-flight correction.
        }
        clearPostSeek(); seekLatency = undefined;
      }
      if (!correctionAllowed(target)) return 'none';
      latestCorrection = { position: positionSeconds, monotonicMs: now() };
      const drift = positionSeconds - target.currentTime;
      clearTimeout(correction);
      resetRate();
      if (!correctionAllowed(target)) return 'none';
      if (Math.abs(drift) <= 0.15) return 'none';
      const expectedEffect = effect;
      const correctionStart = now();
      if (state.status === 'playing' && !target.paused && Math.abs(drift) <= 0.35 && rateFallbackOccurrence !== occurrence()) {
        const rate = drift > 0 ? 1.05 : 0.95;
        try {
          target.playbackRate = rate;
          if (Math.abs(target.playbackRate - rate) > 0.001) throw new Error('Rate rejected');
          correction = setTimeout(() => {
            if (detached || effect !== expectedEffect || !matchesSource(target)) return;
            resetRate();
            if (!correctionAllowed(target)) return; // Restoring rate can itself change decoder readiness.
            const expected = positionSeconds + (now() - correctionStart) / 1000;
            if (Math.abs(expected - target.currentTime) > 0.15) correctionSeek(target, expected);
          }, 4000);
          return 'rate';
        } catch { report('unsupported-rate'); }
      }
      return correctionSeek(target, positionSeconds) ? 'seek' : 'none';
    },
    detach() {
      if (detached) return;
      detached = true;
      visibility?.removeEventListener('visibilitychange', onVisibilityChange);
      visibility?.removeEventListener('freeze', suspend);
      pageLifecycle?.removeEventListener('pagehide', suspend);
      cancelEffects();
      port.pause();
      port.detach();
    }
  };

  const visibility = options.visibility === undefined
    ? typeof document === 'undefined' ? null : document
    : options.visibility;
  const pageLifecycle = options.pageLifecycle === undefined
    ? typeof window === 'undefined' ? null : window
    : options.pageLifecycle;
  const hiddenNonAudio = () => Boolean(state && visibility?.hidden
    && state.queue[state.entryIds.indexOf(state.currentEntryId)]?.mediaType !== 'audio');
  const suspend = () => {
    if (detached || localPaused) return;
    attachment.pauseLocally();
    report('suspended');
  };
  const onVisibilityChange = () => {
    if (hiddenNonAudio()) suspend();
  };
  visibility?.addEventListener('visibilitychange', onVisibilityChange);
  visibility?.addEventListener('freeze', suspend);
  pageLifecycle?.addEventListener('pagehide', suspend);

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
        if (target.ended) { clearPostSeek(); seekLatency = undefined; }
        if (target.ended && (target.readyState ?? 0) >= 2 && !seekPending) report('ended');
        return target.ended; // The store records completion without advancing its room queue.
      }
      if (event === 'pause') {
        if (!target.paused) return false;
        firstProgress = undefined;
        clearPostSeek(); seekLatency = undefined;
        latestCorrection = undefined;
      }
      if (event === 'error' && !target.error) return false;
      if (event === 'error') { clearPostSeek(); seekLatency = undefined; }
      if (event === 'seeking' && target.seeking && postSeek?.completed) { clearPostSeek(); seekLatency = undefined; }
      if (event === 'seeking' && target.seeking && firstProgress) firstProgress.seeking = true;
      if (event === 'seeked' && !target.seeking) {
        if (seekPending && Math.abs(target.currentTime - seekTarget) > 0.15) {
          seekFailed = true;
          seekPending = false;
          report('unsupported-seek');
          return false;
        }
        seekPending = false;
        if (firstProgress?.seeking) {
          firstProgress.position = target.currentTime;
          firstProgress.monotonicMs = now();
          firstProgress.seeking = false;
        }
        if (postSeek && !postSeek.completed && currentPostSeek()) {
          if (Math.abs(target.currentTime - postSeek.target) > 0.15) { clearPostSeek(); seekLatency = undefined; }
          else {
            postSeek.completed = true;
            postSeek.baselinePosition = target.currentTime;
            postSeek.baselineAt = now();
          }
        }
        report('seek-complete');
      }
      if (['loadedmetadata', 'canplay', 'seeked'].includes(event)) void reconcile();
      if (event === 'timeupdate' && postSeek) observePostSeekProgress(target);
      if (event === 'timeupdate' && firstProgress && !firstProgress.seeking && correctionAllowed(target)
        && !target.ended && !target.error && state && now() >= state.anchorMonotonicMs
        && finiteNonnegative(target.currentTime)) {
        const elapsed = (now() - firstProgress.monotonicMs) / 1000;
        const advanced = target.currentTime - firstProgress.position;
        // Rebase an instantaneous or implausible jump so merely waiting cannot later turn that write into progress.
        if (elapsed <= 0 || advanced < 0 || advanced > elapsed * Math.max(1, target.playbackRate ?? 1) + 0.05) {
          firstProgress.position = target.currentTime;
          firstProgress.monotonicMs = now();
        } else if (advanced > 0.02) {
          // Ready/playing can precede decoder progress. Consume before correction; seek callbacks never rearm it.
          firstProgress = undefined;
          // Heartbeats may refine the clock offset without needing a seek; never replace that estimate with the cached anchor.
          const position = latestCorrection ? latestCorrection.position + (now() - latestCorrection.monotonicMs) / 1000 : desiredPosition();
          attachment.correct(position);
        }
      }
      return true;
    }
  };
};
