import { ApiError, isSocialRolloutGate } from './client';

/** Only an explicit feature gate proves a 503 command never reached its commit boundary. */
export const isUncertainSocialFailure = (error: unknown) => !(error instanceof ApiError)
  || error.kind !== 'http' || !error.status
  || (error.status >= 500 && !isSocialRolloutGate(error.status, error.code))
  || error.status === 408;

/** A disabled rollout is a definite rejection that the UI explains as temporary unavailability. */
export const isSocialRolloutFailure = (error: unknown) => error instanceof ApiError
  && error.kind === 'http' && isSocialRolloutGate(error.status, error.code);
