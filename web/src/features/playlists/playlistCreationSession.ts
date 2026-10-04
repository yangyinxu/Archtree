import { useSyncExternalStore } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { captureAccountOperation, isAccountOperationCurrent, subscribeToAccountEpoch } from '../../api/accountEpoch';
import { createPlaylist, createPlaylistIdempotencyKey, playlistNameSchema, type PlaylistDetail } from '../../api/playlists';
import { commitPlaylistDetail, revalidatePlaylistLists } from './playlistCache';

interface CreationIntent { readonly name: string; readonly key: string; readonly expiresAt: number }
interface CreationState {
  viewerId: string;
  intent: CreationIntent | null;
  status: 'idle' | 'pending' | 'uncertain' | 'expired' | 'confirmed' | 'rejected';
  result: PlaylistDetail | null;
  error: unknown;
}
const empty: CreationState = { viewerId: '', intent: null, status: 'idle', result: null, error: null };

/** Only a definite rejection releases a dispatched identity; transport and contention failures remain recoverable. */
const rejected = (error: unknown) => error instanceof ApiError && error.kind === 'http'
  && Boolean(error.status && error.status >= 400 && error.status < 500)
  && ![408, 425, 429].includes(error.status!) && error.code !== 'idempotency_in_progress';

/** Keeps one explicit create intent alive across dialogs/routes, but never across account epochs. */
export const createPlaylistCreationSession = (send = createPlaylist) => {
  let state = empty, generation = 0;
  let guard = captureAccountOperation('');
  let client: QueryClient | undefined;
  const listeners = new Set<() => void>();
  const emit = (change: Partial<CreationState>) => {
    state = { ...state, ...change };
    for (const listener of listeners) listener();
  };
  const current = (viewerId: string, observed = generation) => observed === generation
    && Boolean(viewerId) && state.viewerId === viewerId && isAccountOperationCurrent(guard, viewerId);
  const reset = () => {
    generation++; state = empty; client = undefined;
    for (const listener of listeners) listener();
  };
  const perform = async (viewerId: string, intent: CreationIntent) => {
    const observed = generation, capturedGuard = guard, capturedClient = client!;
    emit({ intent, status: 'pending', result: null, error: null });
    try {
      const detail = await send({ viewerId, name: intent.name, idempotencyKey: intent.key });
      if (!current(viewerId, observed) || state.intent !== intent) return;
      commitPlaylistDetail(capturedClient, viewerId, detail, capturedGuard);
      // A failed refresh cannot turn the acknowledged creation back into an unknown outcome.
      void revalidatePlaylistLists(capturedClient, viewerId, capturedGuard).catch(() => undefined);
      emit({ status: 'confirmed', result: detail });
    } catch (error) {
      if (!current(viewerId, observed) || state.intent !== intent) return;
      const definite = rejected(error);
      emit({ status: definite ? 'rejected' : 'uncertain', intent: definite ? null : intent, error });
    }
  };
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    ensure(viewerId: string, queryClient: QueryClient) {
      if (!current(viewerId)) { reset(); guard = captureAccountOperation(viewerId); emit({ viewerId }); }
      client = queryClient;
    },
    reset,
    start(viewerId: string, name: string) {
      if (!current(viewerId) || state.intent) return Promise.resolve();
      const normalizedName = playlistNameSchema.parse(name);
      const intent = Object.freeze({ name: normalizedName, key: createPlaylistIdempotencyKey(), expiresAt: Date.now() + 24 * 60 * 60 * 1000 });
      generation++;
      return perform(viewerId, intent);
    },
    retry(viewerId: string) {
      if (!current(viewerId) || state.status !== 'uncertain' || !state.intent) return Promise.resolve();
      // Once the server's receipt window has passed, the old key could execute a new creation.
      if (Date.now() >= state.intent.expiresAt) { emit({ status: 'expired' }); return Promise.resolve(); }
      return perform(viewerId, state.intent);
    },
    abandon(viewerId: string, key: string) {
      if (!current(viewerId) || !['uncertain', 'expired'].includes(state.status) || state.intent?.key !== key) return false;
      generation++; emit({ intent: null, status: 'idle', result: null, error: null });
      return true;
    },
    takeConfirmed(viewerId: string, key: string) {
      if (!current(viewerId) || state.status !== 'confirmed' || state.intent?.key !== key) return null;
      const detail = state.result;
      generation++; emit({ intent: null, status: 'idle', result: null, error: null });
      return detail;
    }
  };
};

export const playlistCreationSession = createPlaylistCreationSession();
subscribeToAccountEpoch(playlistCreationSession.reset);
export const usePlaylistCreationSession = () => useSyncExternalStore(
  playlistCreationSession.subscribe, playlistCreationSession.getSnapshot, playlistCreationSession.getSnapshot
);
