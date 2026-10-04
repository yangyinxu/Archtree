import { Link, useNavigate } from 'react-router';

import { requestBrowserPasswordReset } from '../../api/account';
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
 * Starts password recovery without disclosing whether an email has an
 * account. Only an address whose domain cannot receive mail is rejected, on
 * the field; every accepted request shows the address it used.
 */
export const ForgotPasswordPage = () => {
  const { t } = useLocalization();
  const navigate = useNavigate();
  const form = useEmailRequestForm({ request: requestBrowserPasswordReset });
  const error = form.failure
    ? privateAccountActionError(form.failure, t('account.common.request_error'))
    : '';

  return (
    <AuthPageFrame
      eyebrow={t('auth.recovery.eyebrow')}
      title={t('auth.recovery.title')}
      description={t('auth.recovery.description')}
    >
      <form aria-busy={form.isPending} className={styles.formCard} onSubmit={form.submit}>
        <h2 className={styles.formTitle}>{t('auth.recovery.form_title')}</h2>
        <AuthFormFeedback error={error} focusKey={form.failureKey} />
        <EmailRequestSent form={form} message={t('auth.recovery.accepted')} />
        <AuthEmailField form={form} id="forgot-email" />
        <button className={`${styles.button} ${styles.buttonPrimary}`} disabled={form.isPending} type="submit">
          {form.isPending ? t('auth.recovery.sending') : t('auth.recovery.send')}
        </button>
        {form.sentTo && (
          <button
            className={`${styles.button} ${styles.buttonSecondary}`}
            onClick={() => navigate('/reset-password', { state: { email: form.sentTo } })}
            type="button"
          >
            {t('auth.recovery.enter')}
          </button>
        )}
        <p className={styles.authFooter}><Link className={styles.inlineLink} to="/login">{t('account.common.back_login')}</Link></p>
      </form>
    </AuthPageFrame>
  );
};
