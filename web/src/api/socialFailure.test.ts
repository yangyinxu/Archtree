import { ApiError } from './client';
import { isUncertainSocialFailure } from './socialFailure';

test.each(['social_disabled', 'rooms_disabled'])('explicit %s rejection permits a subsequent safety action', code => {
  expect(isUncertainSocialFailure(new ApiError('Disabled', 'http', 503, code))).toBe(false);
});
test.each([new ApiError('Unknown', 'http', 503, 'mutation_outcome_unknown'), new ApiError('Unavailable', 'http', 503),
  new ApiError('Network', 'network'), new ApiError('Malformed response', 'invalid-response', 200)])('keeps an uncertain dispatched outcome for explicit recovery', error => {
  expect(isUncertainSocialFailure(error)).toBe(true);
});
