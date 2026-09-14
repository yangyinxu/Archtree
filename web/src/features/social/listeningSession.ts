import { useSyncExternalStore } from 'react';
import type { ListeningAction, ListeningPlayback, ListeningRoomOccurrence } from '../../../../src/contracts/listeningV1';
import { captureAccountOperation, isAccountOperationCurrent, subscribeToAccountEpoch } from '../../api/accountEpoch';
import { getOwnListening, sendListeningReport, type ListeningOwnerRead, type ListeningReport, type OwnListeningState } from '../../api/listening';
import { prepareSocialCommand, sendSocialCommand, getSocialOutcome, type SocialCommand, type SocialOutcome } from '../../api/social';
import { isUncertainSocialFailure } from '../../api/socialFailure';
import type { MessageKey } from '../../localization/contract';

export interface ListeningSample {
  intentId: number; sourceId: string; occurrenceId: string; mediaTrackId: string; positionMs: number; observedAtMs: number;
  room: null | { roomId: string; epoch: number; playbackEpoch: number; entryId: string; mediaRevision: string };
}
export type ListeningObservation = { type: 'intent'; intentId: number }
  | { type: 'playing' | 'progress'; sample: ListeningSample } | { type: 'stopped'; occurrenceId: string | null };
interface ListeningState {
  viewerId: string; own: OwnListeningState | null; busy: boolean; error: MessageKey | null;
  uncertain: SocialCommand | null; owned: boolean; publishing: boolean;
}
interface Lease {
  publicationId: string; preferenceRevision: number; publisherRevision: number; sequence: number; intentId: number;
  playingSequence: number; expiresAtMs: number; current: ListeningPlayback | null; lastSentAt: number; lastPosition: number;
}
const empty: ListeningState = { viewerId: '', own: null, busy: false, error: null, uncertain: null, owned: false, publishing: false };

/** One account-owned publisher retains receipt recovery separately from ephemeral, observation-only reports. */
export const createListeningSession = (options: {
  now?: () => number; read?: typeof getOwnListening; prepare?: typeof prepareSocialCommand; send?: typeof sendSocialCommand;
  outcome?: typeof getSocialOutcome; report?: typeof sendListeningReport;
} = {}) => {
  const now = options.now ?? (() => performance.now());
  const read = options.read ?? getOwnListening, prepare = options.prepare ?? prepareSocialCommand;
  const send = options.send ?? sendSocialCommand, outcome = options.outcome ?? getSocialOutcome, report = options.report ?? sendListeningReport;
  let attached = false, attachment = 0;
  let state = empty, version = 0, clientId = '', intentId = 0, uncertainIntent = 0, blockedOff = false;
  let guard = captureAccountOperation('');
  let clock: { server: number; mono: number } | null = null;
  let lease: Lease | null = null;
  let latest: ListeningSample | null = null;
  const claimDeadlines = new Map<string, { expires: number; attachment: number }>();
  let readPending: Promise<boolean> | null = null;
  let interval: ReturnType<typeof setInterval> | undefined, expiry: ReturnType<typeof setTimeout> | undefined;
  let noteIntent: () => void = () => undefined;
  let roomOccurrence: (sample: ListeningSample) => ListeningRoomOccurrence | null | undefined = sample => sample.room ? undefined : null;
  const listeners = new Set<() => void>();
  const emit = (value: Partial<ListeningState>) => { state = { ...state, ...value }; for (const listener of listeners) listener(); };
  const current = (captured = version) => captured === version && Boolean(state.viewerId) && isAccountOperationCurrent(guard, state.viewerId);
  const serverNow = () => clock ? clock.server + now() - clock.mono : 0;
  const lose = () => { lease = null; clearTimeout(expiry); emit({ owned: false, publishing: false, error: 'listening.lost' }); };
  const armExpiry = (owned: Lease) => {
    clearTimeout(expiry);
    expiry = setTimeout(() => { if (lease === owned && current()) lose(); }, Math.max(1, owned.expiresAtMs - serverNow()));
  };
  const ingest = (value: ListeningOwnerRead) => {
    // A response's server timestamp predates its arrival. Delayed polls cannot
    // rewind an established estimate and make fresh playback look expired.
    const previousAtReceipt = clock ? clock.server + value.receivedAtMs - clock.mono : 0;
    clock = { server: Math.max(previousAtReceipt, value.listening.serverTimeMs), mono: value.receivedAtMs };
    emit({ own: value.listening });
    if (lease && (!value.listening.enabled || value.listening.revision !== lease.preferenceRevision
      || value.listening.publisherRevision !== lease.publisherRevision)) lose();
    else if (lease) {
      if (serverNow() >= lease.expiresAtMs) lose();
      else armExpiry(lease);
    }
  };
  const refresh = () => {
    if (!current()) return Promise.resolve(false);
    if (readPending) return readPending;
    const captured = version, viewer = state.viewerId;
    const pending = read(viewer).then(value => { if (!current(captured)) return false; ingest(value); return true; })
      .catch(() => { if (current(captured)) emit({ error: 'social.error' }); return false; })
      .finally(() => { if (readPending === pending) readPending = null; });
    readPending = pending; return pending;
  };
  const dispatch = (owned: Lease, input: ListeningReport) => {
    const captured = version, viewer = state.viewerId;
    if (!current()) return;
    void report(viewer, input).then(result => {
      if (!current(captured) || lease !== owned || owned.sequence !== input.sequence) return;
      if (!result.accepted) { lose(); return; }
      // Early accepted reports can keep the same expiry. Never substitute arrival time + a new lifetime.
      if (result.expiresAtMs !== null) { owned.expiresAtMs = result.expiresAtMs; armExpiry(owned); }
      emit({ publishing: input.state === 'playing' && owned.current?.occurrenceId === input.playback.occurrenceId, error: null });
    }).catch(() => { if (current(captured) && lease === owned && owned.sequence === input.sequence) emit({ publishing: false, error: 'social.error' }); });
  };
  const identity = (owned: Lease) => ({ clientId, publicationId: owned.publicationId,
    expectedPreferenceRevision: owned.preferenceRevision, expectedPublisherRevision: owned.publisherRevision, sequence: ++owned.sequence });
  const stopOccurrence = (occurrenceId: string | null) => {
    const owned = lease;
    if (!owned || !occurrenceId || owned.current?.occurrenceId !== occurrenceId) return;
    owned.current = null; emit({ publishing: false });
    dispatch(owned, { ...identity(owned), state: 'stopped', occurrenceId, playbackSequence: owned.playingSequence });
  };
  const stopLocal = () => { latest = null; stopOccurrence(lease?.current?.occurrenceId ?? null); };
  const publish = (sample: ListeningSample, started: boolean) => {
    const owned = lease;
    if (!current() || blockedOff || !state.own?.enabled || !owned || owned.intentId !== sample.intentId || intentId !== sample.intentId || !clock) return;
    if (serverNow() >= owned.expiresAtMs) { lose(); return; }
    if (now() - sample.observedAtMs > 5000 || sample.observedAtMs - now() > 2000) return;
    const room = roomOccurrence(sample); if (room === undefined) { stopLocal(); return; }
    const freshOccurrence = owned.current?.occurrenceId !== sample.occurrenceId;
    if (!started && !freshOccurrence && (sample.positionMs <= owned.lastPosition || now() - owned.lastSentAt < 10_000)) return;
    const playback: ListeningPlayback = { sourceId: sample.sourceId, occurrenceId: sample.occurrenceId,
      mediaTrackId: sample.mediaTrackId, positionMs: sample.positionMs, room };
    owned.current = playback; owned.lastSentAt = now(); owned.lastPosition = sample.positionMs;
    const capturedIdentity = identity(owned); owned.playingSequence = capturedIdentity.sequence;
    dispatch(owned, { ...capturedIdentity, state: 'playing', playback,
      observedAtMs: Math.max(0, Math.round(clock.server + sample.observedAtMs - clock.mono)) });
  };
  const settle = async (command: SocialCommand, result: SocialOutcome, observedIntent: number, captured: number) => {
    emit({ uncertain: null, error: result.outcome === 'rejected' ? 'social.stale' : null });
    // An owner read started before this write may contain the old revision even if its response arrives later.
    if (readPending) await readPending;
    if (!current(captured)) return false;
    const fresh = await refresh(); if (!fresh || !current(captured) || result.outcome === 'rejected') return false;
    if (command.action === 'claimListening' && attached && claimDeadlines.get(command.commandId)?.attachment === attachment && intentId === observedIntent && state.own?.enabled
      && serverNow() < (claimDeadlines.get(command.commandId)?.expires ?? 0)
      && state.own.revision === command.expectedPreferenceRevision && state.own.publisherRevision === command.expectedPublisherRevision + 1) {
      lease = { publicationId: command.commandId, preferenceRevision: command.expectedPreferenceRevision,
        publisherRevision: command.expectedPublisherRevision + 1, sequence: 0, intentId: observedIntent,
        playingSequence: 0, expiresAtMs: claimDeadlines.get(command.commandId)!.expires, current: null, lastSentAt: -Infinity, lastPosition: -1 };
      armExpiry(lease); emit({ owned: true, publishing: false, error: null });
      if (latest?.intentId === observedIntent) publish(latest, true);
    }
    if (command.action === 'setListeningSharing' && command.enabled) blockedOff = false;
    return command.action === 'setListeningSharing' && command.enabled;
  };
  const perform = async (action?: ListeningAction, retry?: SocialCommand, observedIntent = intentId) => {
    if (!current() || state.busy || state.uncertain && !retry) return;
    const captured = version, generation = attachment; let command = retry, dispatched = false, optedIn = false;
    emit({ busy: true, error: null });
    try {
      command ??= await prepare(state.viewerId, action!);
      if (!current(captured) || command.action === 'claimListening' && (!attached || generation !== attachment || observedIntent !== intentId
        || !retry && claimDeadlines.has(command.commandId) && claimDeadlines.get(command.commandId)!.attachment !== attachment)) return;
      if (command.action === 'claimListening' && !claimDeadlines.has(command.commandId)) claimDeadlines.set(command.commandId, { expires: serverNow() + 25_000, attachment });
      dispatched = true; const result = await send(state.viewerId, command);
      if (current(captured)) optedIn = await settle(command, result, observedIntent, captured);
    } catch (error) {
      if (!current(captured)) return;
      const unknown = dispatched && command && isUncertainSocialFailure(error);
      uncertainIntent = observedIntent; emit({ uncertain: unknown ? command! : null, error: unknown ? 'social.unknown' : 'social.error' });
    } finally { if (current(captured)) { emit({ busy: false }); if (optedIn) noteIntent();
      // A distinct explicit gesture received while a scope was pending remains that user's pending intent.
      else if (observedIntent !== intentId && !blockedOff) void claim(intentId);
    } }
  };
  const claim = async (observedIntent: number) => {
    if (!current() || !attached || state.busy || blockedOff || state.own?.enabled === false) return;
    if (state.uncertain) {
      if (state.uncertain.action !== 'claimListening' || observedIntent <= uncertainIntent) return;
      emit({ uncertain: null });
    }
    const captured = version, generation = attachment;
    const fresh = await refresh();
    if (!fresh || !current(captured) || !attached || generation !== attachment || intentId !== observedIntent || !state.own?.enabled || state.busy || state.uncertain) return;
    if (lease && serverNow() < lease.expiresAtMs) {
      lease.intentId = observedIntent;
      if (latest?.intentId === observedIntent) publish(latest, true);
      return;
    }
    await perform({ action: 'claimListening', clientId, expectedPreferenceRevision: state.own.revision,
      expectedPublisherRevision: state.own.publisherRevision }, undefined, observedIntent);
  };
  const observe = (event: ListeningObservation) => {
    if (!current() || !attached) return;
    if (event.type === 'intent') {
      intentId = event.intentId; latest = null;
      void claim(intentId); return;
    }
    if (event.type === 'stopped') {
      if (latest?.occurrenceId === event.occurrenceId) latest = null;
      stopOccurrence(event.occurrenceId); return;
    }
    if (event.sample.intentId !== intentId) return;
    latest = event.sample; publish(event.sample, event.type === 'playing');
  };
  const pause = () => {
    attached = false; attachment++;
    clearInterval(interval); interval = undefined; stopLocal();
    // A detached observer has a new source namespace on return and must obtain ownership from a new gesture.
    lease = null; clearTimeout(expiry); emit({ owned: false, publishing: false });
  };
  const reset = () => {
    pause(); version++; clearTimeout(expiry); lease = null; latest = null; clock = null; readPending = null;
    blockedOff = false; intentId = 0; claimDeadlines.clear(); state = empty; for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => state, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    ensure(viewerId: string, documentClientId: string, onIntent?: () => void, enrich?: typeof roomOccurrence) {
      if (state.viewerId !== viewerId || !current()) { reset(); guard = captureAccountOperation(viewerId); clientId = documentClientId; emit({ viewerId }); }
      attached = true;
      if (onIntent) noteIntent = onIntent; if (enrich) roomOccurrence = enrich;
      if (!interval) { void refresh(); interval = setInterval(() => { if (current()) void refresh(); }, 15_000); }
    },
    observe, pause, reset, refresh,
    getClock: (viewerId: string) => current() && state.viewerId === viewerId && clock
      ? { server: serverNow(), mono: now() } : null,
    async setEnabled(enabled: boolean) {
      if (!enabled) { blockedOff = true; stopLocal(); }
      if (!state.own || state.busy || state.uncertain) return;
      await perform({ action: 'setListeningSharing', enabled, expectedRevision: state.own.revision });
    },
    useDevice: () => { if (attached && current() && state.own?.enabled && !state.busy && (!state.uncertain || state.uncertain.action === 'claimListening')) { blockedOff = false; noteIntent(); } },
    retry: () => state.uncertain ? perform(undefined, state.uncertain, uncertainIntent) : Promise.resolve(),
    async check() {
      if (!current() || !state.uncertain || state.busy) return;
      const captured = version, command = state.uncertain; let optedIn = false; emit({ busy: true });
      try { const result = await outcome(state.viewerId, command); if (current(captured) && result.outcome) optedIn = await settle(command, result.outcome, uncertainIntent, captured); }
      catch { if (current(captured)) emit({ error: 'social.unknown' }); }
      finally { if (current(captured)) { emit({ busy: false }); if (optedIn) noteIntent(); } }
    }
  };
};

export const listeningSession = createListeningSession();
subscribeToAccountEpoch(() => listeningSession.reset());
export const useListeningSession = () => useSyncExternalStore(listeningSession.subscribe, listeningSession.getSnapshot, listeningSession.getSnapshot);
