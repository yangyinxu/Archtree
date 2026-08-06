import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';

import {
  resendBrowserVerification,
  verifyBrowserEmail
} from '../../api/account';
import styles from './AccountSurfaces.module.css';
import {
  AuthFormFeedback,
  AuthPageFrame,
  emailFromRouteState,
  noticeFromRouteState,
  privateAccountActionError,
  verificationActionError
} from './AuthFormSupport';

const acceptedResendMessage = 'If this address still needs verification, a new code has been sent.';

/** Completes email ownership verification and supports a non-enumerating resend. */
export const VerifyEmailPage = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const [email, setEmail] = useState(() => emailFromRouteState(location.state));
  const [status, setStatus] = useState(() => noticeFromRouteState(location.state));
  const verify = useMutation({
    mutationFn: verifyBrowserEmail,
    onSuccess: () => {
      navigate('/login', {
        replace: true,
        state: { notice: 'Email verified. You can now log in.' }
      });
    }
  });
  const resend = useMutation({
    mutationFn: resendBrowserVerification,
    onSuccess: () => setStatus(acceptedResendMessage)
  });
  const error = verify.isError
    ? verificationActionError(verify.error)
    : resend.isError
      ? privateAccountActionError(resend.error)
      : '';

  return (
    <AuthPageFrame
      eyebrow="Verify email"
      title="One short code, then you’re in."
      description="Enter the six-digit code from your verification email. Each code works once and expires."
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
        <h2 className={styles.formTitle}>Verify your email</h2>
        <AuthFormFeedback error={error} status={status} focusKey={Math.max(verify.submittedAt, resend.submittedAt)} />
        <div className={styles.field}>
          <label htmlFor="verify-email">Email</label>
          <input autoComplete="email" defaultValue={email} id="verify-email" maxLength={254} name="email" onChange={(event) => setEmail(event.currentTarget.value)} required type="email" />
        </div>
        <div className={styles.field}>
          <label htmlFor="verification-code">Verification code</label>
          <input autoComplete="one-time-code" id="verification-code" inputMode="numeric" maxLength={6} minLength={6} name="code" pattern="[0-9]{6}" required type="text" />
        </div>
        <button className={`${styles.button} ${styles.buttonPrimary}`} disabled={verify.isPending || resend.isPending} type="submit">
          {verify.isPending ? 'Verifying…' : 'Verify email'}
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
          {resend.isPending ? 'Sending code…' : 'Send a new code'}
        </button>
        <p className={styles.authFooter}><Link className={styles.inlineLink} to="/login">Back to Log in</Link></p>
      </form>
    </AuthPageFrame>
  );
};
