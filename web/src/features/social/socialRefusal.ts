import { ApiError, isSocialRolloutGate } from '../../api/client';
import type { MessageKey } from '../../localization/contract';

/**
 * Backend refusal codes that have a specific, actionable explanation. The codes
 * come from the Archtree social, music-share, listening and room planners. A
 * definite rejection that is not listed is a lost race against a newer revision,
 * epoch, queue or controller generation, which keeps the generic "this changed"
 * copy because the refreshed state already explains it. `profile_unavailable`
 * deliberately does not distinguish missing, hidden, deactivated or blocked
 * profiles, so a block stays private. A Map ignores prototype keys in a code.
 */
const refusals = new Map<string, MessageKey>([
  ['handle_unavailable', 'social.handle_unavailable'],
  ['handle_immutable', 'social.handle_locked'],
  ['handle_reserved', 'social.handle_reserved'],
  ['alias_reserved', 'social.alias_reserved'],
  ['social_suspended', 'social.suspended_action'],
  ['request_pending', 'social.request_incoming'],
  ['profile_unavailable', 'social.profile_unavailable'],
  ['social_limit', 'social.rate_limited'],
  ['music_unavailable', 'music_shares.unavailable'],
  ['music_share_capacity', 'music_shares.limit'],
  ['music_share_limit', 'music_shares.limit'],
  ['room_capacity', 'room.capacity'],
  ['room_full', 'room.full'],
  ['room_invitation_capacity', 'room.invitation_limit'],
  ['already_in_room', 'room.existing_room'],
  ['host_absent', 'room.suspended'],
  ['host_exit_required', 'room.host_exit_required'],
  ['room_forbidden', 'room.forbidden'],
  ['room_unavailable', 'room.no_longer_available'],
  ['invitation_unavailable', 'room.invitation_unavailable'],
  ['room_media_unavailable', 'room.media_unavailable'],
  ['room_queue_capacity', 'room.queue_full'],
  ['room_queue_empty', 'room.queue_last_entry'],
  ['current_entry_required', 'room.queue_current_hint'],
  ['room_request_capacity', 'room.request_capacity'],
  ['room_request_unavailable', 'room.request_unavailable'],
  ['room_reaction_limit', 'room.reaction_limit'],
  ['transfer_unavailable', 'room.transfer_unavailable'],
  ['stale_controller', 'room.observing']
]);

/**
 * The same code means different things for different gestures: the social cap
 * that refuses a request is the pending-request or recipient abuse limit, for an
 * acceptance it is the friend limit, for a block it is the block limit, and for a
 * report it is the daily report limit. Room creation past the deployment's
 * open-room limit is `room_capacity`, and a join into a room at its member limit
 * is `room_full`, so neither needs the gesture. A listening profile refusal can
 * only concern the listener's own inactive profile.
 */
const actionRefusals = new Map<string, MessageKey>([
  ['social_limit:request', 'social.request_limit'],
  ['social_limit:accept', 'social.friend_limit'],
  ['social_limit:block', 'social.block_limit'],
  ['social_limit:report', 'social.report_limit'],
  ['profile_unavailable:setListeningSharing', 'social.inactive'],
  ['profile_unavailable:claimListening', 'social.inactive']
]);

/** Explains a definite `rejected` outcome for the action that was refused. */
export const socialRejectionMessage = (code?: string, action?: string): MessageKey =>
  (code && (actionRefusals.get(`${code}:${action}`) ?? refusals.get(code))) || 'social.stale';

/**
 * Explains a definite failed request (never an uncertain one). A rollout gate is
 * temporary unavailability on the given surface, and a 429 means the account's
 * short command rate or retained-receipt allowance is spent, so retrying at once
 * cannot help.
 */
export const socialFailureMessage = (error: unknown, unavailable: MessageKey): MessageKey => {
  if (!(error instanceof ApiError) || error.kind !== 'http') return 'social.error';
  if (isSocialRolloutGate(error.status, error.code)) return unavailable;
  return error.status === 429 ? 'social.rate_limited' : 'social.error';
};

const isRejectedOutcome = (refusal: unknown): refusal is { outcome: 'rejected'; code?: string } =>
  typeof refusal === 'object' && refusal !== null && (refusal as { outcome?: unknown }).outcome === 'rejected';

/**
 * The room session's single on-demand entry point, kept to one call shape so the
 * always-loaded room code stays within its JavaScript budget: a rejected outcome
 * is explained by its code, anything else is a definite failed request.
 */
export const roomRefusalMessage = (refusal: unknown, action?: string): MessageKey => isRejectedOutcome(refusal)
  ? socialRejectionMessage(refusal.code, action) : socialFailureMessage(refusal, 'room.unavailable');
