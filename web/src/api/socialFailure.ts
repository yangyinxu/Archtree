import { ApiError } from './client';

/** Only an explicit feature gate proves a 503 command never reached its commit boundary. */
export const isUncertainSocialFailure = (error: unknown) => !(error instanceof ApiError)
  || error.kind !== 'http' || !error.status
  || (error.status >= 500 && !['social_disabled', 'rooms_disabled'].includes(error.code ?? ''))
  || error.status === 408;
