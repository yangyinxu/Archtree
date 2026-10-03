import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';

import {
  browserAuthenticationCapabilitiesQuery,
  requestBrowserRegistration
} from '../../api/account';
import styles from './AccountSurfaces.module.css';
import { useLocalization } from '../../localization/LocalizationProvider';
import {
  AuthFormFeedback,
  AuthPageFrame,
  privateAccountActionError
} from './AuthFormSupport';

/**
 * Starts Web registration with only an email address. Every address gets the
 * same "check your email" status: the email holds a registration link, or a
 * notice that the address already has an account. The form stays available so
 * the listener can ask again.
 */
export const RegisterPage = () => {
  const { t } = useLocalization();
  const capabilities = useQuery(browserAuthenticationCapabilitiesQuery());
  const request = useMutation({ mutationFn: requestBrowserRegistration });
  const registrationUnavailable = capabilities.isError
    || (capabilities.isSuccess && !capabilities.data.emailRegistration);
  const error = request.isError
    ? privateAccountActionError(request.error, t('account.common.request_error'))
    : '';

  return (
    <AuthPageFrame
      eyebrow={t('auth.register.eyebrow')}
      title={t('auth.register.title')}
      description={t('auth.register.link_description')}
    >
      <form
        aria-busy={request.isPending}
        className={styles.formCard}
        onSubmit={(event) => {
          event.preventDefault();
          request.reset();
          const form = new FormData(event.currentTarget);
          request.mutate({ email: String(form.get('email') ?? '') });
        }}
      >
        <h2 className={styles.formTitle}>{t('auth.register.form_title')}</h2>
        <AuthFormFeedback
          error={error}
          status={request.isSuccess ? t('auth.register.link_sent') : ''}
          focusKey={request.submittedAt}
        />
        {registrationUnavailable ? (
          <div className={styles.compactState}>
            <p>{capabilities.isError
              ? t('auth.register.availability_error')
              : t('auth.register.unavailable')}</p>
            {capabilities.isError && (
              <button className={styles.textButton} onClick={() => capabilities.refetch()} type="button">{t('common.action.try_again')}</button>
            )}
            <Link className={styles.inlineLink} to="/login">{t('account.common.return_login')}</Link>
          </div>
        ) : (
          <>
            <div className={styles.field}>
              <label htmlFor="register-email">{t('account.field.email')}</label>
              <input autoComplete="email" id="register-email" maxLength={254} name="email" required type="email" />
            </div>
            <button className={`${styles.button} ${styles.buttonPrimary}`} disabled={request.isPending || capabilities.isPending} type="submit">
              {request.isPending
                ? t('auth.register.sending_link')
                : capabilities.isPending ? t('auth.register.checking') : t('auth.register.send_link')}
            </button>
          </>
        )}
        <p className={styles.authFooter}>{t('auth.register.already_account')} <Link className={styles.inlineLink} to="/login">{t('common.action.log_in')}</Link></p>
      </form>
    </AuthPageFrame>
  );
};
