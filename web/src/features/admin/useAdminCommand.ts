import { useState, useSyncExternalStore } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import { ApiError } from '../../api/client';
import { ADMIN_IMPORT_RELOAD_REQUIRED, adminEndpointRequest } from './adminTransport';
import { ADMIN_RELOAD_REQUIRED, adminWorkspace } from './adminWorkspace';

interface Intent { path: string; body: string; operationId: string; method: string }
/** `musicbrainz_id_in_use`: another Artist, or another Organization, already keeps the MusicBrainz ID an edit sets. */
interface CommandState<T> { running: boolean; intent: Intent | null; result: T | null; error: 'unknown' | 'conflict' | 'error' | 'reload' | 'musicbrainz_id_in_use' | null }
/** Clears catalog projections after a confirmed global edit, while retaining identity and Save membership facts. */
export function clearCatalogProjections(client: QueryClient) {
  const filter = { predicate: (query: { queryKey: readonly unknown[] }) => query.queryKey[0] === 'listener'
    ? !['save-statuses', 'playlist-memberships'].includes(String(query.queryKey[1]))
    : query.queryKey[0] === 'social' && ['music-shares', 'listening-friends', 'room-media-search', 'room-media-track', 'room-community'].includes(String(query.queryKey[2])) };
  void client.cancelQueries(filter); client.removeQueries(filter);
}
/** Catalog edits share immutable retry keys, but have independent revision and response contracts. */
export class AdminCommand<T extends { receipt: { operationId: string } }> {
  private state: CommandState<T> = { running: false, intent: null, result: null, error: null };
  private listeners = new Set<() => void>();
  private owner = adminWorkspace.capture();
  constructor(private schema: z.ZodType<T>, private confirmed: () => void = () => {}) {}
  getSnapshot = () => this.state;
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private update(next: CommandState<T>) { this.state = next; for (const fn of this.listeners) fn(); }
  run(path: string, payload: object, method = 'PATCH') {
    if (this.state.running || this.state.intent || !adminWorkspace.current(this.owner, false)) return;
    const operationId = crypto.randomUUID(); void this.send({ path, method, operationId, body: JSON.stringify({ ...payload, operationId }) });
  }
  reconcile(path: string, operationId: string) {
    if (this.state.running || this.state.intent || !adminWorkspace.current(this.owner, false)) return;
    void this.send({ path, method: 'POST', operationId, body: '{}' });
  }
  retry = () => { if (this.state.intent && !this.state.running) void this.send(this.state.intent); };
  acknowledge = () => this.update({ ...this.state, result: null });
  private async send(intent: Intent) {
    if (!adminWorkspace.current(this.owner, false)) return;
    const guard = adminWorkspace.capture(); this.update({ running: true, intent, result: null, error: null });
    try {
      const result = await adminEndpointRequest(intent.path, this.schema, { method: intent.method, body: intent.body }, guard);
      if (!adminWorkspace.current(this.owner, false)) return;
      if (result.receipt.operationId !== intent.operationId) throw new ApiError('Unconfirmed receipt', 'invalid-response');
      this.confirmed();
      this.update({ running: false, intent: null, result, error: null });
    } catch (error) {
      if (!adminWorkspace.current(this.owner, false)) return;
      // An outdated bundle cannot read the result, so it offers a reload instead of resending the intent.
      if (error instanceof ApiError && error.code === ADMIN_RELOAD_REQUIRED) { this.update({ running: false, intent: null, result: null, error: 'reload' }); return; }
      // A source import or review saved by a newer release refuses this change before admission.
      if (error instanceof ApiError && error.kind === 'http' && error.status === 409 && error.code === ADMIN_IMPORT_RELOAD_REQUIRED) { this.update({ running: false, intent: null, result: null, error: 'reload' }); return; }
      if (error instanceof ApiError && error.kind === 'http' && error.status === 409 && error.code === 'ADMIN_CATALOG_MUSICBRAINZ_ID_IN_USE') { this.update({ running: false, intent: null, result: null, error: 'musicbrainz_id_in_use' }); return; }
      const definite = error instanceof ApiError && error.kind === 'http' && [400, 401, 403, 404, 409, 422].includes(error.status ?? 0);
      this.update({ running: false, intent: definite ? null : intent, result: null, error: definite ? (error instanceof ApiError && error.status === 409 ? 'conflict' : 'error') : 'unknown' });
    }
  }
}
export function useAdminCommand<T extends { receipt: { operationId: string } }>(key: string, schema: z.ZodType<T>) {
  const client = useQueryClient();
  const [command] = useState(() => {
    const found = adminWorkspace.buffer<AdminCommand<T>>(`command:${key}`); if (found) return found;
    const value = new AdminCommand(schema, () => clearCatalogProjections(client)); adminWorkspace.retain(`command:${key}`, value, adminWorkspace.capture()); return value;
  });
  return { command, ...useSyncExternalStore(command.subscribe, command.getSnapshot, command.getSnapshot) };
}
