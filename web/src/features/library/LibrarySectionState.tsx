import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { browserSessionQueryKey } from '../../api/session';
import { useLocalization } from '../../localization/LocalizationProvider';
import styles from './LibraryPage.module.css';

/** Private section failures expire the displayed session without exposing another account. */
export const useSectionAuthentication = (error: unknown) => {
  const client = useQueryClient();
  useEffect(() => {
    if (error instanceof ApiError && error.status === 401) client.setQueryData(browserSessionQueryKey, null);
  }, [error, client]);
};

/** Each section owns its retry; a failed request is never represented as an empty collection. */
export const SectionError = ({ retry }: { retry: () => unknown }) => {
  const { t } = useLocalization();
  return <div className={styles.state} role="alert">
    <p>{t('library.section.error')}</p>
    <button type="button" onClick={() => retry()}>{t('common.action.try_again')}</button>
  </div>;
};
