import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { isUncertainSocialFailure } from '../../api/socialFailure';
import { captureAccountOperation, isAccountOperationCurrent } from '../../api/accountEpoch';
import { getSocialOutcome, prepareSocialCommand, sendSocialCommand, type SocialAction, type SocialCommand, type SocialOutcome } from '../../api/social';
import type { MessageKey } from '../../localization/contract';

/** Keeps an uncertain original command for explicit outcome lookup or same-intent retry. */
export const useSocialActions = (viewerId: string) => {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<MessageKey | null>(null);
  const [uncertain, setUncertain] = useState<SocialCommand | null>(null);
  const locked = useRef(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['social', viewerId] });
  const settle = async (outcome: SocialOutcome) => {
    setUncertain(null);
    setMessage(outcome.outcome === 'rejected' ? 'social.stale' : 'social.updated');
    await refresh();
  };
  const perform = async (action?: SocialAction, retry?: SocialCommand) => {
    if (locked.current || (uncertain && !retry)) return;
    locked.current = true; setBusy(true); setMessage(null);
    const guard = captureAccountOperation(viewerId);
    let command = retry;
    try {
      command ??= await prepareSocialCommand(viewerId, action!);
      const outcome = await sendSocialCommand(viewerId, command);
      if (isAccountOperationCurrent(guard)) await settle(outcome);
    } catch (error) {
      if (!isAccountOperationCurrent(guard)) return;
      const unknown = command && isUncertainSocialFailure(error);
      setUncertain(unknown ? command! : null);
      setMessage(unknown ? 'social.unknown' : 'social.error');
    } finally { locked.current = false; setBusy(false); }
  };
  const check = async () => {
    if (!uncertain || locked.current) return;
    locked.current = true; setBusy(true);
    const guard = captureAccountOperation(viewerId);
    try {
      const result = await getSocialOutcome(viewerId, uncertain);
      if (!isAccountOperationCurrent(guard)) return;
      if (result.outcome) await settle(result.outcome);
      else setMessage('social.unknown');
    } catch { if (isAccountOperationCurrent(guard)) setMessage('social.unknown'); }
    finally { locked.current = false; setBusy(false); }
  };
  return { busy, message, uncertain, run: (action: SocialAction) => perform(action),
    retry: () => uncertain ? perform(undefined, uncertain) : Promise.resolve(), check, refresh };
};
