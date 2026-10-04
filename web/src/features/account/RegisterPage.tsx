import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';

import {
  browserAuthenticationCapabilitiesQuery,
  requestBrowserRegistration
} from '../../api/account';
import styles from './AccountSurfaces.module.css';
import { useLocalization } from '../../localization/LocalizationProvider';
import {
  AuthEmailField,
  AuthFormFeedback,
  AuthPageFrame,
  EmailRequestSent,
  privateAccountActionError,
  useEmailRequestForm
} from './AuthFormSupport';

/**
 * Starts Web registration with only an email address. Every accepted address
 * gets the same "check your email" status with the address it used: the email
 * holds a registration link, or a notice that the address already has an
 * account. An address whose domain cannot receive mail is rejected on the
 * field. The form stays available so the listener can ask again.
 */
export const RegisterPage = () => {
  const { t } = useLocalization();
  const capabilities = useQuery(browserAuthenticationCapabilitiesQuery());
  const form = useEmailRequestForm({ request: requestBrowserRegistration });
  const registrationUnavailable = capabilities.isError
    || (capabilities.isSuccess && !capabilities.data.emailRegistration);
  const error = form.failure
    ? privateAccountActionError(form.failure, t('account.common.request_error'))
    : '';

  return (
    <AuthPageFrame
      eyebrow={t('auth.register.eyebrow')}
      title={t('auth.register.title')}
      description={t('auth.register.link_description')}
    >
      <form aria-busy={form.isPending} className={styles.formCard} onSubmit={form.submit}>
        <h2 className={styles.formTitle}>{t('auth.register.form_title')}</h2>
        <AuthFormFeedback error={error} focusKey={form.failureKey} />
        <EmailRequestSent form={form} message={t('auth.register.link_sent')} />
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
            <AuthEmailField form={form} id="register-email" />
            <button className={`${styles.button} ${styles.buttonPrimary}`} disabled={form.isPending || capabilities.isPending} type="submit">
              {form.isPending
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
