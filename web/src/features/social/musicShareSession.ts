import { useSyncExternalStore } from 'react';
import type { MusicShareAction } from '../../../../src/contracts/socialMusicV1';
import { captureAccountOperation, isAccountOperationCurrent, subscribeToAccountEpoch } from '../../api/accountEpoch';
import type { SocialCommand, SocialOutcome } from '../../api/social';
import { isUncertainSocialFailure } from '../../api/socialFailure';
import type { MessageKey } from '../../localization/contract';

interface ShareState {
  viewerId: string; busy: boolean; message: MessageKey | null; uncertain: SocialCommand | null;
}
const empty: ShareState = { viewerId: '', busy: false, message: null, uncertain: null };

/** Retains the original uncertain share across dialog closes and route changes, fenced to the account epoch. */
export const createMusicShareSession = () => {
  let state = empty;
  let version = 0;
  let guard = captureAccountOperation('');
  let invalidate: () => void | Promise<unknown> = () => undefined;
  const listeners = new Set<() => void>();
  const emit = (next: Partial<ShareState>) => { state = { ...state, ...next }; for (const listener of listeners) listener(); };
  const current = (observed: number) => observed === version && Boolean(state.viewerId) && isAccountOperationCurrent(guard, state.viewerId);
  const stop = () => { version++; state = empty; for (const listener of listeners) listener(); };
  const settle = async (outcome: SocialOutcome) => {
    const message: MessageKey = outcome.outcome !== 'rejected' ? 'social.updated'
      : outcome.code === 'music_unavailable' ? 'music_shares.unavailable'
        : ['music_share_capacity', 'music_share_limit'].includes(outcome.code ?? '') ? 'music_shares.limit' : 'social.stale';
    emit({ uncertain: null, message });
    // A failed read refresh cannot make an already acknowledged mutation uncertain.
    try { await invalidate(); } catch { /* The query surface owns its read error. */ }
  };
  const perform = async (action?: MusicShareAction, retry?: SocialCommand) => {
    if (!current(version) || state.busy || (state.uncertain && !retry)) return;
    const observed = version;
    const viewerId = state.viewerId;
    const intent = action ? Object.freeze({ ...action }) : undefined;
    let command = retry;
    let dispatched = false;
    emit({ busy: true, message: null });
    try {
      const { prepareSocialCommand, sendSocialCommand } = await import('../../api/social');
      if (!current(observed)) return;
      command ??= await prepareSocialCommand(viewerId, intent!);
      if (!current(observed)) return;
      dispatched = true;
      const outcome = await sendSocialCommand(viewerId, command);
      if (current(observed)) await settle(outcome);
    } catch (error) {
      if (!current(observed)) return;
      const unknown = dispatched && command && isUncertainSocialFailure(error);
      emit({ uncertain: unknown ? command! : null, message: unknown ? 'social.unknown' : 'social.error' });
    } finally { if (current(observed)) emit({ busy: false }); }
  };
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    ensure(viewerId: string, refresh: () => void | Promise<unknown>) {
      if (state.viewerId !== viewerId || !current(version)) {
        stop(); guard = captureAccountOperation(viewerId); emit({ viewerId });
      }
      invalidate = refresh;
    },
    stop,
    run: (action: MusicShareAction) => perform(action),
    retry: () => state.uncertain ? perform(undefined, state.uncertain) : Promise.resolve(),
    async check() {
      if (!state.uncertain || state.busy || !current(version)) return;
      const observed = version;
      emit({ busy: true });
      try {
        const { getSocialOutcome } = await import('../../api/social');
        if (!current(observed)) return;
        const result = await getSocialOutcome(state.viewerId, state.uncertain);
        if (current(observed) && result.outcome) await settle(result.outcome);
      } catch { if (current(observed)) emit({ message: 'social.unknown' }); }
      finally { if (current(observed)) emit({ busy: false }); }
    }
  };
};

export const musicShareSession = createMusicShareSession();
subscribeToAccountEpoch(() => musicShareSession.stop());
export const useMusicShareSession = () => useSyncExternalStore(musicShareSession.subscribe, musicShareSession.getSnapshot, musicShareSession.getSnapshot);
