import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';

import {
  browserAuthenticationCapabilitiesQuery,
  registerBrowserAccount
} from '../../api/account';
import styles from './AccountSurfaces.module.css';
import { useLocalization } from '../../localization/LocalizationProvider';
import {
  AuthFormFeedback,
  AuthPageFrame,
  privateAccountActionError
} from './AuthFormSupport';

/** Creates an email account without revealing whether the address already exists. */
export const RegisterPage = () => {
  const { t } = useLocalization();
  const navigate = useNavigate();
  const capabilities = useQuery(browserAuthenticationCapabilitiesQuery());
  const [localError, setLocalError] = useState('');
  const register = useMutation({
    mutationFn: registerBrowserAccount,
    onSuccess: (_data, variables) => {
      navigate('/verify-email', {
        state: { email: variables.email, notice: t('auth.register.accepted') }
      });
    }
  });
  const registrationUnavailable = capabilities.isError
    || (capabilities.isSuccess && !capabilities.data.emailRegistration);
  const error = localError || (register.isError
    ? privateAccountActionError(register.error, t('account.common.request_error'))
    : '');

  return (
    <AuthPageFrame
      eyebrow={t('auth.register.eyebrow')}
      title={t('auth.register.title')}
      description={t('auth.register.description')}
    >
      <form
        aria-busy={register.isPending}
        className={styles.formCard}
        onSubmit={(event) => {
          event.preventDefault();
          setLocalError('');
          register.reset();
          const form = new FormData(event.currentTarget);
          const password = String(form.get('password') ?? '');
          if (password !== String(form.get('confirmPassword') ?? '')) {
            setLocalError(t('account.common.password_mismatch'));
            return;
          }
          register.mutate({
            email: String(form.get('email') ?? ''),
            password,
            displayName: String(form.get('displayName') ?? '') || undefined
          });
        }}
      >
        <h2 className={styles.formTitle}>{t('auth.register.form_title')}</h2>
        <AuthFormFeedback error={error} focusKey={register.submittedAt} />
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
              <label htmlFor="register-name">{t('account.field.name')} <span className={styles.optional}>{t('account.field.optional')}</span></label>
              <input autoComplete="name" id="register-name" maxLength={80} name="displayName" type="text" />
            </div>
            <div className={styles.field}>
              <label htmlFor="register-email">{t('account.field.email')}</label>
              <input autoComplete="email" id="register-email" maxLength={254} name="email" required type="email" />
            </div>
            <div className={styles.field}>
              <label htmlFor="register-password">{t('account.field.password')}</label>
              <input
                aria-describedby="register-password-hint"
                autoComplete="new-password"
                id="register-password"
                maxLength={256}
                minLength={12}
                name="password"
                required
                type="password"
              />
              <p className={styles.fieldHint} id="register-password-hint">{t('account.common.password_hint')}</p>
            </div>
            <div className={styles.field}>
              <label htmlFor="register-confirm-password">{t('account.field.confirm_password')}</label>
              <input autoComplete="new-password" id="register-confirm-password" maxLength={256} minLength={12} name="confirmPassword" required type="password" />
            </div>
            <button className={`${styles.button} ${styles.buttonPrimary}`} disabled={register.isPending || capabilities.isPending} type="submit">
              {register.isPending ? t('auth.register.creating') : capabilities.isPending ? t('auth.register.checking') : t('auth.login.create_account')}
            </button>
          </>
        )}
        <p className={styles.authFooter}>{t('auth.register.already_account')} <Link className={styles.inlineLink} to="/login">{t('common.action.log_in')}</Link></p>
      </form>
    </AuthPageFrame>
  );
};
