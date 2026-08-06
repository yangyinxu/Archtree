import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';

import { requestBrowserPasswordReset } from '../../api/account';
import styles from './AccountSurfaces.module.css';
import {
  AuthFormFeedback,
  AuthPageFrame,
  privateAccountActionError
} from './AuthFormSupport';

const acceptedRecoveryMessage = 'If this address can reset a password, a recovery email has been sent.';

/** Starts password recovery without disclosing whether an email has an account. */
export const ForgotPasswordPage = () => {
  const navigate = useNavigate();
  const [submittedEmail, setSubmittedEmail] = useState('');
  const forgot = useMutation({
    mutationFn: requestBrowserPasswordReset,
    onSuccess: (_data, variables) => setSubmittedEmail(variables.email)
  });
  const error = forgot.isError ? privateAccountActionError(forgot.error) : '';

  return (
    <AuthPageFrame
      eyebrow="Password recovery"
      title="Find your way back to the music."
      description="Enter your email and we’ll send a six-digit reset code when that address can use password recovery."
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
        <h2 className={styles.formTitle}>Reset your password</h2>
        <AuthFormFeedback error={error} status={forgot.isSuccess ? acceptedRecoveryMessage : ''} focusKey={forgot.submittedAt} />
        <div className={styles.field}>
          <label htmlFor="forgot-email">Email</label>
          <input autoComplete="email" id="forgot-email" maxLength={254} name="email" required type="email" />
        </div>
        <button className={`${styles.button} ${styles.buttonPrimary}`} disabled={forgot.isPending} type="submit">
          {forgot.isPending ? 'Sending reset code…' : 'Send reset code'}
        </button>
        {forgot.isSuccess && (
          <button
            className={`${styles.button} ${styles.buttonSecondary}`}
            onClick={() => navigate('/reset-password', { state: { email: submittedEmail } })}
            type="button"
          >
            Enter reset code
          </button>
        )}
        <p className={styles.authFooter}><Link className={styles.inlineLink} to="/login">Back to Log in</Link></p>
      </form>
    </AuthPageFrame>
  );
};
