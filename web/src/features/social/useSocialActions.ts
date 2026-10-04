import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { isSocialRolloutFailure, isUncertainSocialFailure } from '../../api/socialFailure';
import { captureAccountOperation, isAccountOperationCurrent } from '../../api/accountEpoch';
import { getSocialOutcome, prepareSocialCommand, sendSocialCommand, type SocialAction, type SocialCommand, type SocialOutcome } from '../../api/social';
import type { MessageKey } from '../../localization/contract';

/**
 * Name-policy, suspension and report-limit rejections tell the listener what to
 * do; any other rejection means the state moved on and the refreshed view is now current.
 */
const rejectionMessage = (code: string | undefined, report: boolean): MessageKey => code === 'handle_reserved' ? 'social.handle_reserved'
  : code === 'alias_reserved' ? 'social.alias_reserved' : code === 'social_suspended' ? 'social.suspended_action'
    : report && code === 'social_limit' ? 'social.report_limit' : 'social.stale';

/** Keeps an uncertain original command for explicit outcome lookup or same-intent retry. */
export const useSocialActions = (viewerId: string) => {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<MessageKey | null>(null);
  const [uncertain, setUncertain] = useState<SocialCommand | null>(null);
  const locked = useRef(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['social', viewerId] });
  // A repeated report on the same day is a server noop; the reporter sees the same confirmation.
  const settle = async (outcome: SocialOutcome, command: SocialCommand) => {
    setUncertain(null);
    const report = command.action === 'report';
    setMessage(outcome.outcome === 'rejected' ? rejectionMessage(outcome.code, report) : report ? 'social.report_sent' : 'social.updated');
    await refresh();
  };
  const perform = async (action?: SocialAction, retry?: SocialCommand) => {
    if (locked.current || (uncertain && !retry)) return;
    locked.current = true; setBusy(true); setMessage(null);
    const guard = captureAccountOperation(viewerId);
    let command = retry;
    try {
      command ??= await prepareSocialCommand(viewerId, action!);
      if (!isAccountOperationCurrent(guard)) return;
      const outcome = await sendSocialCommand(viewerId, command);
      if (isAccountOperationCurrent(guard)) await settle(outcome, command);
    } catch (error) {
      if (!isAccountOperationCurrent(guard)) return;
      const unknown = command && isUncertainSocialFailure(error);
      setUncertain(unknown ? command! : null);
      // A disabled rollout is definite and explained; the shell refreshes capabilities from the same response.
      setMessage(unknown ? 'social.unknown' : isSocialRolloutFailure(error) ? 'social.unavailable' : 'social.error');
    } finally { locked.current = false; setBusy(false); }
  };
  const check = async () => {
    if (!uncertain || locked.current) return;
    locked.current = true; setBusy(true);
    const guard = captureAccountOperation(viewerId);
    try {
      const result = await getSocialOutcome(viewerId, uncertain);
      if (!isAccountOperationCurrent(guard)) return;
      if (result.outcome) await settle(result.outcome, uncertain);
      else setMessage('social.unknown');
    } catch { if (isAccountOperationCurrent(guard)) setMessage('social.unknown'); }
    finally { locked.current = false; setBusy(false); }
  };
  return { busy, message, uncertain, run: (action: SocialAction) => perform(action),
    retry: () => uncertain ? perform(undefined, uncertain) : Promise.resolve(), check, refresh };
};
