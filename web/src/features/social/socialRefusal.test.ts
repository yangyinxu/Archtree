import enBundle from '../../../../localization/generated/bundles/en-US.json';
import zhBundle from '../../../../localization/generated/bundles/zh-Hans.json';
import { ApiError } from '../../api/client';
import { roomRefusalMessage, socialFailureMessage, socialRejectionMessage } from './socialRefusal';

test.each([
  ['handle_unavailable', 'profile', 'social.handle_unavailable'],
  ['handle_immutable', 'profile', 'social.handle_locked'],
  ['handle_reserved', 'profile', 'social.handle_reserved'],
  ['alias_reserved', 'profile', 'social.alias_reserved'],
  ['social_suspended', 'profile', 'social.suspended_action'],
  ['request_pending', 'request', 'social.request_incoming'],
  ['profile_unavailable', 'request', 'social.profile_unavailable'],
  ['profile_unavailable', 'invite', 'social.profile_unavailable'],
  ['social_limit', 'request', 'social.request_limit'],
  ['social_limit', 'accept', 'social.friend_limit'],
  ['social_limit', 'block', 'social.block_limit'],
  ['social_limit', 'report', 'social.report_limit'],
  ['music_unavailable', 'shareMusic', 'music_shares.unavailable'],
  ['music_share_capacity', 'shareMusic', 'music_shares.limit'],
  ['music_share_limit', 'shareMusic', 'music_shares.limit'],
  ['profile_unavailable', 'setListeningSharing', 'social.inactive'],
  ['profile_unavailable', 'claimListening', 'social.inactive'],
  ['room_capacity', 'create', 'room.capacity'],
  ['room_full', 'acceptInvitation', 'room.full'],
  ['room_invitation_capacity', 'invite', 'room.invitation_limit'],
  ['already_in_room', 'create', 'room.existing_room'],
  ['already_in_room', 'acceptInvitation', 'room.existing_room'],
  ['host_absent', 'play', 'room.suspended'],
  ['host_absent', 'react', 'room.suspended'],
  ['host_exit_required', 'leave', 'room.host_exit_required'],
  ['room_forbidden', 'setControlMode', 'room.forbidden'],
  ['room_unavailable', 'leave', 'room.no_longer_available'],
  ['invitation_unavailable', 'acceptInvitation', 'room.invitation_unavailable'],
  ['room_media_unavailable', 'requestSong', 'room.media_unavailable'],
  ['room_queue_capacity', 'acceptSongRequest', 'room.queue_full'],
  ['room_queue_empty', 'removeQueueEntry', 'room.queue_last_entry'],
  ['current_entry_required', 'removeQueueEntry', 'room.queue_current_hint'],
  ['room_request_capacity', 'requestSong', 'room.request_capacity'],
  ['room_request_unavailable', 'acceptSongRequest', 'room.request_unavailable'],
  ['room_reaction_limit', 'react', 'room.reaction_limit'],
  ['transfer_unavailable', 'acceptTransfer', 'room.transfer_unavailable'],
  ['stale_controller', 'next', 'room.observing']
])('a %s refusal of %s explains its actual reason', (code, action, message) => {
  expect(socialRejectionMessage(code, action)).toBe(message);
});

test.each([
  ['relationship_changed', 'accept'], ['profile_revision_changed', 'profile'], ['relationship_unavailable', 'cancel'],
  ['listening_preference_changed', 'setListeningSharing'], ['listening_publisher_changed', 'claimListening'],
  ['stale_epoch', 'react'], ['stale_playback', 'next'], ['stale_queue', 'select'], ['stale_permission', 'play'],
  ['queue_entries_changed', 'reorderQueue'], ['entry_unavailable', 'select']
])('a lost %s race on %s keeps the "this changed" copy because the refreshed state explains it', (code, action) => {
  expect(socialRejectionMessage(code, action)).toBe('social.stale');
});

test.each([undefined, '', 'future_code', 'constructor', '__proto__', 'toString', 'hasOwnProperty'])(
  'an absent, unknown or prototype-named code %s falls back to the generic copy', code => {
    expect(socialRejectionMessage(code, 'request')).toBe('social.stale');
    expect(socialRejectionMessage(code)).toBe('social.stale');
  });

test('an action-specific code without a matching gesture uses its general explanation', () => {
  expect(socialRejectionMessage('room_capacity')).toBe('room.capacity');
  expect(socialRejectionMessage('social_limit', 'remove')).toBe('social.rate_limited');
  expect(socialRejectionMessage('profile_unavailable')).toBe('social.profile_unavailable');
});

test('a definite failure distinguishes a rollout gate, a rate limit and other errors', () => {
  expect(socialFailureMessage(new ApiError('Disabled', 'http', 503, 'social_disabled'), 'social.unavailable')).toBe('social.unavailable');
  expect(socialFailureMessage(new ApiError('Disabled', 'http', 503, 'rooms_disabled'), 'room.unavailable')).toBe('room.unavailable');
  expect(socialFailureMessage(new ApiError('Slow down', 'http', 429, 'social_limit', 30), 'social.unavailable')).toBe('social.rate_limited');
  expect(socialFailureMessage(new ApiError('Slow down', 'http', 429), 'social.unavailable')).toBe('social.rate_limited');
  expect(socialFailureMessage(new ApiError('Bad', 'http', 400, 'invalid_request'), 'social.unavailable')).toBe('social.error');
  expect(socialFailureMessage(new ApiError('Expired', 'http', 410, 'mutation_scope_expired'), 'social.unavailable')).toBe('social.error');
  // Only the two rollout codes are a gate; another 503 is never relabelled as unavailable.
  expect(socialFailureMessage(new ApiError('Busy', 'http', 503, 'social_unavailable'), 'social.unavailable')).toBe('social.error');
  expect(socialFailureMessage(new ApiError('Offline', 'network'), 'social.unavailable')).toBe('social.error');
  expect(socialFailureMessage(new TypeError('Account changed.'), 'social.unavailable')).toBe('social.error');
  expect(socialFailureMessage(undefined, 'social.unavailable')).toBe('social.error');
});

test('the room entry point explains rejected outcomes by code and other refusals as failed requests', () => {
  expect(roomRefusalMessage({ commandId: 'room-command-0001', outcome: 'rejected', code: 'room_capacity', replayed: false }, 'create')).toBe('room.capacity');
  expect(roomRefusalMessage({ outcome: 'rejected', code: 'room_full' }, 'acceptInvitation')).toBe('room.full');
  expect(roomRefusalMessage({ outcome: 'rejected' }, 'next')).toBe('social.stale');
  expect(roomRefusalMessage(new ApiError('Disabled', 'http', 503, 'rooms_disabled'))).toBe('room.unavailable');
  expect(roomRefusalMessage(new ApiError('Slow down', 'http', 429, 'social_limit'), 'seek')).toBe('social.rate_limited');
  expect(roomRefusalMessage(new ApiError('Forbidden', 'http', 403))).toBe('social.error');
  expect(roomRefusalMessage(null)).toBe('social.error');
  expect(roomRefusalMessage({ outcome: 'applied' })).toBe('social.error');
});

test('every explanation exists in both shipped locales', () => {
  const codes = ['handle_unavailable', 'handle_immutable', 'handle_reserved', 'alias_reserved', 'social_suspended', 'request_pending', 'profile_unavailable', 'social_limit', 'music_unavailable',
    'music_share_capacity', 'room_capacity', 'room_full', 'room_invitation_capacity', 'already_in_room', 'host_absent', 'host_exit_required',
    'room_forbidden', 'room_unavailable', 'invitation_unavailable', 'room_media_unavailable', 'room_queue_capacity', 'room_queue_empty',
    'current_entry_required', 'room_request_capacity', 'room_request_unavailable', 'room_reaction_limit', 'transfer_unavailable', 'stale_controller'];
  const actions = [undefined, 'request', 'accept', 'block', 'report', 'create', 'setListeningSharing'];
  const keys = new Set([...codes.flatMap(code => actions.map(action => socialRejectionMessage(code, action))), 'social.rate_limited']);
  for (const key of keys) {
    expect(enBundle.messages).toHaveProperty([key]);
    expect(zhBundle.messages).toHaveProperty([key]);
  }
});
