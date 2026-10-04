import { ApiError } from './client';
import { isSocialRolloutFailure, isUncertainSocialFailure } from './socialFailure';

test.each(['social_disabled', 'rooms_disabled'])('explicit %s rejection permits a subsequent safety action', code => {
  expect(isUncertainSocialFailure(new ApiError('Disabled', 'http', 503, code))).toBe(false);
});
test.each([new ApiError('Unknown', 'http', 503, 'mutation_outcome_unknown'), new ApiError('Unavailable', 'http', 503),
  new ApiError('Network', 'network'), new ApiError('Malformed response', 'invalid-response', 200)])('keeps an uncertain dispatched outcome for explicit recovery', error => {
  expect(isUncertainSocialFailure(error)).toBe(true);
});
test.each(['social_disabled', 'rooms_disabled'])('explicit %s rejection is explained as a rollout gate', code => {
  expect(isSocialRolloutFailure(new ApiError('Disabled', 'http', 503, code))).toBe(true);
});
test.each([new ApiError('Unavailable', 'http', 503, 'social_unavailable'), new ApiError('Unavailable', 'http', 503),
  new ApiError('Wrong status', 'http', 500, 'social_disabled'), new ApiError('Network', 'network', undefined, 'social_disabled'),
  new TypeError('social_disabled')])('other failures keep their ordinary handling', error => {
  expect(isSocialRolloutFailure(error)).toBe(false);
});
