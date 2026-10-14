import { useSyncExternalStore } from 'react';
import { captureAccountOperation, isAccountOperationCurrent, subscribeToAccountEpoch, type AccountOperationGuard } from '../../api/accountEpoch';

export interface AdminWorkspaceState {
  viewerId: string;
  epoch: number;
  authorized: boolean;
  mode: 'user' | 'admin';
  generation: number;
  authority: number;
  imports: boolean;
  analysis: boolean;
  catalogEditing: boolean;
  catalogVisibility: boolean;
}

let state: AdminWorkspaceState = { viewerId: '', epoch: -1, authorized: false, mode: 'user', generation: 0, authority: 0, imports: false, analysis: false, catalogEditing: false, catalogVisibility: false };
const listeners = new Set<() => void>();
/** Private editing buffers survive view/route changes, never an account or permission change. */
const buffers = new Map<string, unknown>();
const emit = () => { for (const listener of listeners) listener(); };

export const adminWorkspace = {
  getSnapshot: () => state,
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  reset() {
    buffers.clear();
    state = { viewerId: '', epoch: -1, authorized: false, mode: 'user', generation: state.generation + 1, authority: state.authority + 1, imports: false, analysis: false, catalogEditing: false, catalogVisibility: false };
    emit();
  },
  suspend() {
    state = { ...state, authorized: false, generation: state.generation + 1 }; emit();
  },
  authorize(guard: AccountOperationGuard, imports: boolean, analysis: boolean, authority = state.authority, catalog = { editing: false, visibility: false }) {
    if (!isAccountOperationCurrent(guard) || authority !== state.authority) return;
    const same = state.viewerId === guard.viewerId && state.epoch === guard.epoch;
    if (!same) buffers.clear();
    state = { viewerId: guard.viewerId, epoch: guard.epoch, authorized: true, imports, analysis, authority, catalogEditing: catalog.editing, catalogVisibility: catalog.visibility,
      mode: same ? state.mode : 'user', generation: same ? state.generation : state.generation + 1 };
    emit();
  },
  select(mode: 'user' | 'admin') {
    if (!state.authorized || !isAccountOperationCurrent(state)) return;
    if (state.mode === mode) return;
    state = { ...state, mode, generation: state.generation + 1 }; emit();
  },
  capture() {
    if (!state.authorized || state.mode !== 'admin' || !isAccountOperationCurrent(state)) throw new Error('Administrator view is unavailable.');
    return { ...captureAccountOperation(state.viewerId), generation: state.generation, authority: state.authority };
  },
  current(guard: AccountOperationGuard & { generation?: number; authority?: number }, requireView = true) {
    return (guard.authority === undefined || guard.authority === state.authority) && (!requireView || state.authorized) && isAccountOperationCurrent(guard, state.viewerId) && state.epoch === guard.epoch
      && (!requireView || state.mode === 'admin' && guard.generation === state.generation);
  },
  buffer<T>(key: string): T | undefined { return buffers.get(key) as T | undefined; },
  retain(key: string, value: unknown, guard: AccountOperationGuard) {
    if (this.current(guard, false)) buffers.set(key, value);
  },
  forget(key: string) { buffers.delete(key); }
};

subscribeToAccountEpoch(() => adminWorkspace.reset());
export const useAdminWorkspace = () => useSyncExternalStore(adminWorkspace.subscribe, adminWorkspace.getSnapshot, adminWorkspace.getSnapshot);
