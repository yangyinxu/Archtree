import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';

import { requestBrowserPasswordReset } from '../../api/account';
import styles from './AccountSurfaces.module.css';
import { useLocalization } from '../../localization/LocalizationProvider';
import {
  AuthFormFeedback,
  AuthPageFrame,
  privateAccountActionError
} from './AuthFormSupport';

/** Starts password recovery without disclosing whether an email has an account. */
export const ForgotPasswordPage = () => {
  const { t } = useLocalization();
  const navigate = useNavigate();
  const [submittedEmail, setSubmittedEmail] = useState('');
  const forgot = useMutation({
    mutationFn: requestBrowserPasswordReset,
    onSuccess: (_data, variables) => setSubmittedEmail(variables.email)
  });
  const error = forgot.isError
    ? privateAccountActionError(forgot.error, t('account.common.request_error'))
    : '';

  return (
    <AuthPageFrame
      eyebrow={t('auth.recovery.eyebrow')}
      title={t('auth.recovery.title')}
      description={t('auth.recovery.description')}
    >
      <form
        aria-busy={forgot.isPending}
        className={styles.formCard}
        onSubmit={(event) => {
          event.preventDefault();
          forgot.reset();
          const form = new FormData(event.currentTarget);
          forgot.mutate({ email: String(form.get('email') ?? '') });
        }}
      >
        <h2 className={styles.formTitle}>{t('auth.recovery.form_title')}</h2>
        <AuthFormFeedback error={error} status={forgot.isSuccess ? t('auth.recovery.accepted') : ''} focusKey={forgot.submittedAt} />
        <div className={styles.field}>
          <label htmlFor="forgot-email">{t('account.field.email')}</label>
          <input autoComplete="email" id="forgot-email" maxLength={254} name="email" required type="email" />
        </div>
        <button className={`${styles.button} ${styles.buttonPrimary}`} disabled={forgot.isPending} type="submit">
          {forgot.isPending ? t('auth.recovery.sending') : t('auth.recovery.send')}
        </button>
        {forgot.isSuccess && (
          <button
            className={`${styles.button} ${styles.buttonSecondary}`}
            onClick={() => navigate('/reset-password', { state: { email: submittedEmail } })}
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
