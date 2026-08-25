import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';

import { resetBrowserPassword } from '../../api/account';
import type { BrowserSession } from '../../api/schemas';
import { browserSessionQueryKey } from '../../api/session';
import { useLocalization } from '../../localization/LocalizationProvider';
import styles from './AccountSurfaces.module.css';
import { clearSearchHistory } from '../search/searchHistory';
import {
  AuthFormFeedback,
  AuthPageFrame,
  emailFromRouteState,
  verificationActionError
} from './AuthFormSupport';

/** Completes recovery and discards cached identity when the reset account is current. */
export const ResetPasswordPage = () => {
  const { t } = useLocalization();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [localError, setLocalError] = useState('');
  const reset = useMutation({
    mutationFn: resetBrowserPassword,
    onSuccess: (_data, variables) => {
      const current = queryClient.getQueryData<BrowserSession | null>(browserSessionQueryKey);
      if (current?.user.email.toLowerCase() === variables.email.toLowerCase()) {
        clearSearchHistory(current.user.id);
        queryClient.clear();
        queryClient.setQueryData(browserSessionQueryKey, null);
      }
      navigate('/login', {
        replace: true,
        state: { notice: t('auth.reset.success') }
      });
    }
  });
  const error = localError || (reset.isError
    ? verificationActionError(reset.error, t('account.common.code_error'))
    : '');

  return (
    <AuthPageFrame
      eyebrow={t('auth.reset.eyebrow')}
      title={t('auth.reset.title')}
      description={t('auth.reset.description')}
    >
      <form
        aria-busy={reset.isPending}
        className={styles.formCard}
        onSubmit={(event) => {
          event.preventDefault();
          setLocalError('');
          reset.reset();
          const form = new FormData(event.currentTarget);
          const password = String(form.get('password') ?? '');
          if (password !== String(form.get('confirmPassword') ?? '')) {
            setLocalError(t('account.common.password_mismatch'));
            return;
          }
          reset.mutate({
            email: String(form.get('email') ?? ''),
            code: String(form.get('code') ?? ''),
            password
          });
        }}
      >
        <h2 className={styles.formTitle}>{t('auth.reset.form_title')}</h2>
        <AuthFormFeedback error={error} focusKey={reset.submittedAt} />
        <div className={styles.field}>
          <label htmlFor="reset-email">{t('account.field.email')}</label>
          <input autoComplete="email" defaultValue={emailFromRouteState(location.state)} id="reset-email" maxLength={254} name="email" required type="email" />
        </div>
        <div className={styles.field}>
          <label htmlFor="reset-code">{t('account.field.reset_code')}</label>
          <input autoComplete="one-time-code" id="reset-code" inputMode="numeric" maxLength={6} minLength={6} name="code" pattern="[0-9]{6}" required type="text" />
        </div>
        <div className={styles.field}>
          <label htmlFor="reset-password">{t('account.field.new_password')}</label>
          <input aria-describedby="reset-password-hint" autoComplete="new-password" id="reset-password" maxLength={256} minLength={12} name="password" required type="password" />
          <p className={styles.fieldHint} id="reset-password-hint">{t('account.common.password_hint')}</p>
        </div>
        <div className={styles.field}>
          <label htmlFor="reset-confirm-password">{t('account.field.confirm_new_password')}</label>
          <input autoComplete="new-password" id="reset-confirm-password" maxLength={256} minLength={12} name="confirmPassword" required type="password" />
        </div>
        <button className={`${styles.button} ${styles.buttonPrimary}`} disabled={reset.isPending} type="submit">
          {reset.isPending ? t('auth.reset.resetting') : t('auth.reset.action')}
        </button>
        <p className={styles.authFooter}><Link className={styles.inlineLink} to="/forgot-password">{t('auth.reset.request_another')}</Link></p>
      </form>
    </AuthPageFrame>
  );
};
