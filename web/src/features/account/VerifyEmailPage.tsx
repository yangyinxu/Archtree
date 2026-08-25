import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';

import {
  resendBrowserVerification,
  verifyBrowserEmail
} from '../../api/account';
import styles from './AccountSurfaces.module.css';
import { useLocalization } from '../../localization/LocalizationProvider';
import {
  AuthFormFeedback,
  AuthPageFrame,
  emailFromRouteState,
  noticeFromRouteState,
  privateAccountActionError,
  verificationActionError
} from './AuthFormSupport';

/** Completes email ownership verification and supports a non-enumerating resend. */
export const VerifyEmailPage = () => {
  const { t } = useLocalization();
  const location = useLocation();
  const navigate = useNavigate();
  const [email, setEmail] = useState(() => emailFromRouteState(location.state));
  const [status, setStatus] = useState(() => noticeFromRouteState(location.state));
  const verify = useMutation({
    mutationFn: verifyBrowserEmail,
    onSuccess: () => {
      navigate('/login', {
        replace: true,
        state: { notice: t('auth.verify.success') }
      });
    }
  });
  const resend = useMutation({
    mutationFn: resendBrowserVerification,
    onSuccess: () => setStatus(t('auth.verify.accepted'))
  });
  const error = verify.isError
    ? verificationActionError(verify.error, t('account.common.code_error'))
    : resend.isError
      ? privateAccountActionError(resend.error, t('account.common.request_error'))
      : '';

  return (
    <AuthPageFrame
      eyebrow={t('auth.verify.eyebrow')}
      title={t('auth.verify.title')}
      description={t('auth.verify.description')}
    >
      <form
        aria-busy={verify.isPending || resend.isPending}
        className={styles.formCard}
        onSubmit={(event) => {
          event.preventDefault();
          setStatus('');
          verify.reset();
          resend.reset();
          const form = new FormData(event.currentTarget);
          const nextEmail = String(form.get('email') ?? '');
          setEmail(nextEmail);
          verify.mutate({ email: nextEmail, code: String(form.get('code') ?? '') });
        }}
      >
        <h2 className={styles.formTitle}>{t('auth.verify.form_title')}</h2>
        <AuthFormFeedback error={error} status={status} focusKey={Math.max(verify.submittedAt, resend.submittedAt)} />
        <div className={styles.field}>
          <label htmlFor="verify-email">{t('account.field.email')}</label>
          <input autoComplete="email" defaultValue={email} id="verify-email" maxLength={254} name="email" onChange={(event) => setEmail(event.currentTarget.value)} required type="email" />
        </div>
        <div className={styles.field}>
          <label htmlFor="verification-code">{t('account.field.verification_code')}</label>
          <input autoComplete="one-time-code" id="verification-code" inputMode="numeric" maxLength={6} minLength={6} name="code" pattern="[0-9]{6}" required type="text" />
        </div>
        <button className={`${styles.button} ${styles.buttonPrimary}`} disabled={verify.isPending || resend.isPending} type="submit">
          {verify.isPending ? t('auth.verify.verifying') : t('auth.verify.action')}
        </button>
        <button
          className={`${styles.button} ${styles.buttonSecondary}`}
          disabled={verify.isPending || resend.isPending || !email.trim()}
          onClick={() => {
            setStatus('');
            verify.reset();
            resend.reset();
            resend.mutate({ email });
          }}
          type="button"
        >
          {resend.isPending ? t('auth.verify.sending') : t('auth.verify.send_new')}
        </button>
        <p className={styles.authFooter}><Link className={styles.inlineLink} to="/login">{t('account.common.back_login')}</Link></p>
      </form>
    </AuthPageFrame>
  );
};
