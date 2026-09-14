import { useSyncExternalStore } from 'react';
import { z } from 'zod';
import { isUncertainSocialFailure } from '../../api/socialFailure';
import { captureAccountOperation, isAccountOperationCurrent, subscribeToAccountEpoch } from '../../api/accountEpoch';
import { getCurrentRoom, getRealtimeTicket, prepareRoomCommand, sendRoomCommand, roomControlPreconditions,
  roomSnapshotSchema, type RoomAction, type RoomCommand, type RoomSnapshot } from '../../api/rooms';
import { playerStore } from '../../player';
import type { RoomPlaybackAttachment, RoomPlaybackIntent, RoomPlaybackObservation } from '../../player/roomPlayback';
import type { MessageKey } from '../../localization/contract';

interface RoomSessionState {
  viewerId: string; room: RoomSnapshot | null; connected: boolean; locallyPaused: boolean;
  busy: boolean; error: MessageKey | null; uncertain: RoomCommand | null;
}
const initialState: RoomSessionState = { viewerId: '', room: null, connected: false, locallyPaused: false, busy: false, error: null, uncertain: null };
const incomingMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('subscribed'), protocolVersion: z.literal(1), serverTimeMs: z.number().finite(), room: roomSnapshotSchema.nullable() }).strict(),
  z.object({ type: z.literal('snapshot'), room: roomSnapshotSchema.nullable() }).strict(),
  z.object({ type: z.literal('socialChanged') }).strict(),
  z.object({ type: z.literal('pong'), clientTimeMs: z.number().finite(), serverTimeMs: z.number().finite() }).strict()
]);

/** One authenticated transport controls the app's existing player across route navigation. */
export const createRoomSession = () => {
  let state = initialState;
  const listeners = new Set<() => void>();
  let guard = captureAccountOperation('');
  let socket: WebSocket | undefined;
  let attachment: RoomPlaybackAttachment | undefined;
  let attachedIdentity = '';
  let refreshSocial: (kind: 'social' | 'rooms') => void = () => undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let opening = false;
  let generation = 0;
  let snapshotVersion = 0;
  let readySequence = 0;
  let offset = 0;
  let bestRoundTrip = Infinity;
  let lastPong = 0;
  let lastHeartbeat = -Infinity;
  let lastHeartbeatIdentity = '';
  let clockPings = new Set<number>();
  let anchor: { key: string; milliseconds: number; positionSeconds: number } | undefined;
  const emit = (change: Partial<RoomSessionState>) => {
    state = { ...state, ...change };
    for (const listener of listeners) listener();
  };
  const current = () => Boolean(state.viewerId && isAccountOperationCurrent(guard, state.viewerId));
  const detachPlayer = () => { attachment?.detach(); attachment = undefined; attachedIdentity = ''; anchor = undefined; };
  const send = (message: unknown) => {
    if (!current() || !socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message)); return true;
  };
  const reportReady = (ready: boolean) => {
    const room = state.room;
    if (!room?.timeline || !room.self.isController || !state.connected) return;
    const preparation = room.preparation;
    send({ type: 'ready', report: { roomId: room.roomId, memberId: room.self.memberId,
      controllerGeneration: room.self.controllerGeneration, expectedEpoch: room.epoch,
      preparationId: preparation?.preparationId ?? 'current', playbackGeneration: room.timeline.playbackGeneration,
      entryId: room.timeline.entryId, mediaRevision: room.timeline.mediaRevision, sequence: ++readySequence,
      ready: ready && !state.locallyPaused } });
  };
  const observe = (observation: RoomPlaybackObservation) => {
    if (observation.type === 'suspended') { emit({ locallyPaused: true }); ping(); reportReady(false); }
    else if (observation.type === 'ready' && observation.playbackEpoch === state.room?.timeline?.playbackGeneration) reportReady(true);
    else if (observation.type === 'unsupported-seek') { emit({ error: 'room.start_failed', locallyPaused: true }); ping(); reportReady(false); }
  };
  const transportIntent = (intent: RoomPlaybackIntent) => {
    const room = state.room;
    if (!room || !state.connected || !room.self.canControl || !room.self.isController) return;
    const expected = { roomId: intent.expectedRoomId, memberId: room.self.memberId, controllerGeneration: room.self.controllerGeneration,
      expectedEpoch: intent.expectedEpoch, expectedEntryId: intent.expectedEntryId, expectedPlaybackGeneration: intent.expectedPlaybackEpoch,
      expectedControlGeneration: intent.expectedControlEpoch, expectedQueueRevision: intent.expectedQueueRevision };
    void run(intent.type === 'seek' ? { ...expected, action: 'seek', positionMs: Math.round(intent.positionSeconds * 1000) }
      : intent.type === 'select' ? { ...expected, action: 'select', targetEntryId: intent.entryId }
        : { ...expected, action: intent.type });
  };
  const syncPlayer = async () => {
    const room = state.room;
    if (!current() || !state.connected || !room?.timeline || !room.self.isController || room.status !== 'open') {
      detachPlayer(); return;
    }
    const identity = `${room.roomId}:${room.epoch}:${room.self.memberId}:${room.self.controllerGeneration}`;
    if (attachedIdentity !== identity) {
      // Joining a real room loads the adapter; visiting Social does not preload playback machinery.
      const { createRoomPlaybackController } = await import('../../player/roomPlayback');
      if (room !== state.room || !current() || !state.connected) return;
      detachPlayer();
      attachment = playerStore.attachRoomPlayback({ onIntent: transportIntent, onObservation: observe }, createRoomPlaybackController);
      attachedIdentity = identity;
      if (state.locallyPaused) attachment.pauseLocally();
    }
    const timeline = room.timeline;
    const key = [room.roomId, timeline.playbackGeneration, timeline.state, timeline.positionMs, timeline.anchorServerTimeMs].join(':');
    if (anchor?.key !== key) {
      const raw = timeline.anchorServerTimeMs - offset;
      anchor = { key, milliseconds: Math.max(0, raw), positionSeconds: timeline.positionMs / 1000
        + (timeline.state === 'playing' && raw < 0 ? -raw / 1000 : 0) };
    }
    const ownReady = room.members.find(member => member.memberId === room.self.memberId)?.ready === true;
    await attachment!.apply({ roomId: room.roomId, epoch: room.epoch, revision: room.revision,
      mediaRevision: timeline.mediaRevision, playbackEpoch: timeline.playbackGeneration, controlEpoch: room.controlGeneration,
      queueRevision: room.queueRevision, canControl: room.self.canControl, currentEntryId: timeline.entryId,
      entryIds: room.queue.map(entry => entry.entryId), queue: room.queue.map(entry => ({ id: entry.mediaTrackId,
        title: entry.title, mediaType: 'audio' as const, artistNames: [], artworkUrl: '', streamUrl: entry.streamUrl })),
      positionSeconds: anchor.positionSeconds, anchorMonotonicMs: anchor.milliseconds,
      status: timeline.state, playbackAllowed: ownReady });
  };
  const acceptSnapshot = (room: RoomSnapshot | null, authoritative = false) => {
    if (!current()) return;
    if (authoritative) snapshotVersion += 1;
    if (!room && !state.room) return;
    if (room && state.room?.roomId === room.roomId && room.epoch === state.room.epoch && room.revision < state.room.revision) return;
    if (!authoritative && state.connected) return; // A slower HTTP read cannot replace the live socket's state.
    emit({ room });
    if (state.connected) ping(false);
    void syncPlayer();
  };
  const refresh = async () => {
    const version = generation;
    const observed = snapshotVersion;
    try {
      const result = await getCurrentRoom(state.viewerId);
      if (version === generation && current() && snapshotVersion === observed) acceptSnapshot(result.room, true);
    } catch { if (version === generation && current()) emit({ error: 'social.error' }); }
  };
  const ping = (correctPlayback = true) => {
    const room = state.room;
    const clientTimeMs = performance.now();
    clockPings.add(clientTimeMs);
    if (clockPings.size > 12) clockPings.delete(clockPings.values().next().value!);
    const identity = room && room.self.isController ? `${room.roomId}:${room.self.memberId}:${room.self.controllerGeneration}:${state.locallyPaused}` : '';
    const includeHeartbeat = identity && (identity !== lastHeartbeatIdentity || clientTimeMs - lastHeartbeat >= 4000);
    if (includeHeartbeat) { lastHeartbeatIdentity = identity; lastHeartbeat = clientTimeMs; }
    send({ type: 'ping', clientTimeMs, heartbeat: includeHeartbeat && room ? {
      roomId: room.roomId, memberId: room.self.memberId, controllerGeneration: room.self.controllerGeneration,
      locallyPaused: state.locallyPaused
    } : null });
    if (correctPlayback && room?.timeline?.state === 'playing' && !state.locallyPaused && state.connected) {
      const target = Math.min(room.timeline.durationMs, room.timeline.positionMs + Math.max(0, performance.now() + offset - room.timeline.anchorServerTimeMs));
      attachment?.correct(target / 1000);
    }
  };
  const connect = async () => {
    if (!current() || opening || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
    opening = true;
    const version = generation;
    try {
      const { ticket } = await getRealtimeTicket(state.viewerId);
      if (version !== generation || !current()) return;
      const endpoint = new URL('/api/social/v1/realtime', location.href);
      endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
      const connection = new WebSocket(endpoint, ['archtree-room-v1', ticket]);
      socket = connection;
      connection.onmessage = event => {
        if (connection !== socket || !current() || typeof event.data !== 'string' || event.data.length > 65_536) return;
        let parsed;
        try { parsed = incomingMessage.safeParse(JSON.parse(event.data)); } catch { return; }
        if (!parsed.success) { connection.close(); return; }
        const message = parsed.data;
        if (message.type === 'subscribed') {
          offset = message.serverTimeMs - performance.now(); bestRoundTrip = Infinity; lastPong = performance.now();
          emit({ connected: true, error: null }); acceptSnapshot(message.room, true); ping();
          setTimeout(() => { if (connection === socket) ping(); }, 120);
          setTimeout(() => { if (connection === socket) ping(); }, 350);
        } else if (message.type === 'snapshot') acceptSnapshot(message.room, true);
        else if (message.type === 'socialChanged') refreshSocial('social');
        else if (clockPings.delete(message.clientTimeMs)) {
          const received = performance.now(); const rtt = received - message.clientTimeMs;
          lastPong = received;
          if (rtt >= 0 && rtt < bestRoundTrip) { bestRoundTrip = rtt; offset = message.serverTimeMs - (message.clientTimeMs + received) / 2; }
        }
      };
      connection.onclose = () => {
        if (connection !== socket) return;
        socket = undefined; detachPlayer(); emit({ connected: false, locallyPaused: Boolean(state.room), error: 'room.disconnected' });
        if (current()) retryTimer = setTimeout(() => { void connect(); }, 3000);
      };
      connection.onerror = () => { connection.close(); };
    } catch { if (version === generation && current()) emit({ connected: false, error: 'room.disconnected' }); }
    finally { if (version === generation) opening = false; }
  };
  const settle = async (outcome: { outcome: string }) => {
    emit({ uncertain: null, error: outcome.outcome === 'rejected' ? 'social.stale' : null });
    refreshSocial('rooms');
    await refresh();
    if (state.connected) ping();
  };
  const run = async (action?: RoomAction, retry?: RoomCommand) => {
    if (!current() || state.busy || (state.uncertain && !retry)) return;
    if (!state.connected && action && !['leave', 'end', 'declineInvitation'].includes(action.action)) return;
    const version = generation;
    emit({ busy: true, error: null });
    let command = retry;
    try {
      command ??= await prepareRoomCommand(state.viewerId, action!);
      if (version !== generation || !current()) return;
      const outcome = await sendRoomCommand(state.viewerId, command);
      if (version === generation && current()) await settle(outcome);
    } catch (error) {
      if (version !== generation || !current()) return;
      const unknown = command && isUncertainSocialFailure(error);
      emit({ uncertain: unknown ? command! : null, error: unknown ? 'social.unknown' : 'social.error' });
    } finally { if (version === generation) emit({ busy: false }); }
  };
  const stop = () => {
    generation += 1; opening = false; clearInterval(heartbeat); clearTimeout(retryTimer);
    const previous = socket; socket = undefined; previous?.close(); detachPlayer();
    clockPings = new Set(); lastHeartbeatIdentity = ''; lastHeartbeat = -Infinity; state = initialState; for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    ensure(viewerId: string, onSocialChanged: (kind: 'social' | 'rooms') => void) {
      refreshSocial = onSocialChanged;
      if (state.viewerId === viewerId && current()) return;
      stop(); guard = captureAccountOperation(viewerId); emit({ viewerId });
      void refresh(); void connect();
      heartbeat = setInterval(() => {
        if (!current()) { stop(); return; }
        if (state.connected) {
          if (performance.now() - lastPong > 15_000) socket?.close();
          else ping();
        } else { void refresh(); void connect(); }
      }, 5000);
    },
    run, refresh, reconnect: connect, stop,
    control(action: 'play' | 'pause' | 'next' | 'previous' | 'seek' | 'select' | 'setControlMode', value?: number | string) {
      const room = state.room;
      if (!room?.timeline || !state.connected || !room.self.canControl || !room.self.isController) return Promise.resolve();
      const expected = roomControlPreconditions(room);
      return run(action === 'seek' ? { ...expected, action, positionMs: Math.round(Number(value)) }
        : action === 'select' ? { ...expected, action, targetEntryId: String(value) }
          : action === 'setControlMode' ? { ...expected, action, mode: value as 'hostOnly' | 'everyone' }
            : { ...expected, action });
    },
    pauseLocally() { emit({ locallyPaused: true }); attachment?.pauseLocally(); ping(); reportReady(false); },
    async resync() { if (!state.connected) return; emit({ locallyPaused: false, error: null }); ping(); await attachment?.resync(); },
    retry: () => state.uncertain ? run(undefined, state.uncertain) : Promise.resolve(),
    async checkOutcome() {
      if (!state.uncertain || state.busy) return;
      const version = generation; emit({ busy: true });
      try {
        const { getSocialOutcome } = await import('../../api/social');
        const result = await getSocialOutcome(state.viewerId, state.uncertain);
        if (version === generation && current() && result.outcome) await settle(result.outcome);
      } catch { if (version === generation && current()) emit({ error: 'social.unknown' }); }
      finally { if (version === generation) emit({ busy: false }); }
    }
  };
};

export const roomSession = createRoomSession();
subscribeToAccountEpoch(() => roomSession.stop());
export const useRoomSession = () => useSyncExternalStore(roomSession.subscribe, roomSession.getSnapshot, roomSession.getSnapshot);
