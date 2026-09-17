import { ApiError } from '../../api/client';
import type { LocalizationContextValue } from '../../localization/LocalizationProvider';

/** Maps definitive server failures to existing guidance without retaining unsafe response details. */
export const playlistMutationMessage = (
  error: unknown,
  operation: 'create' | 'rename' | 'delete',
  t: LocalizationContextValue['t']
) => {
  if (!(error instanceof ApiError)) return t('playlist.error.change_unconfirmed');
  if (error.code === 'playlist_limit_reached') {
    return t('playlist.error.playlist_limit');
  }
  if (error.code === 'idempotency_in_progress') {
    return t('playlist.error.request_pending');
  }
  if (error.code === 'idempotency_key_reused') {
    return t('playlist.error.request_key_mismatch');
  }
  if (error.code === 'account_viewer_mismatch' || error.status === 401) {
    return t('playlist.error.account_changed');
  }
  if (error.code === 'playlist_revision_conflict' || error.status === 409) {
    return operation === 'create'
      ? t('playlist.error.replay_unsafe')
      : t('playlist.error.revision_loading');
  }
  if (error.status === 429) return t('playlist.error.rate_limit');
  return t('playlist.error.change_unconfirmed');
};
