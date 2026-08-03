import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';

import {
  browserAuthenticationCapabilitiesQuery,
  registerBrowserAccount
} from '../../api/account';
import styles from '../../styles/Pages.module.css';
import {
  AuthFormFeedback,
  AuthPageFrame,
  privateAccountActionError
} from './AuthFormSupport';

const acceptedRegistrationMessage = 'If this address can be registered, a verification email has been sent.';

/** Creates an email account without revealing whether the address already exists. */
export const RegisterPage = () => {
  const navigate = useNavigate();
  const capabilities = useQuery(browserAuthenticationCapabilitiesQuery());
  const [localError, setLocalError] = useState('');
  const register = useMutation({
    mutationFn: registerBrowserAccount,
    onSuccess: (_data, variables) => {
      navigate('/verify-email', {
        state: { email: variables.email, notice: acceptedRegistrationMessage }
      });
    }
  });
  const registrationUnavailable = capabilities.isError
    || (capabilities.isSuccess && !capabilities.data.emailRegistration);
  const error = localError || (register.isError ? privateAccountActionError(register.error) : '');

  return (
    <AuthPageFrame
      eyebrow="Create account"
      title="Make your Library yours."
      description="Create a Finitude listener account, then verify your email with the six-digit code we send."
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
            setLocalError('The passwords do not match.');
            return;
          }
          register.mutate({
            email: String(form.get('email') ?? ''),
            password,
            displayName: String(form.get('displayName') ?? '') || undefined
          });
        }}
      >
        <h2 className={styles.formTitle}>Create your listener account</h2>
        <AuthFormFeedback error={error} focusKey={register.submittedAt} />
        {registrationUnavailable ? (
          <div className={styles.compactState}>
            <p>{capabilities.isError
              ? 'Finitude could not confirm whether registration is available.'
              : 'Email registration is not available on this deployment.'}</p>
            {capabilities.isError && (
              <button className={styles.textButton} onClick={() => capabilities.refetch()} type="button">Try again</button>
            )}
            <Link className={styles.inlineLink} to="/login">Return to Log in</Link>
          </div>
        ) : (
          <>
            <div className={styles.field}>
              <label htmlFor="register-name">Name <span className={styles.optional}>(optional)</span></label>
              <input autoComplete="name" id="register-name" maxLength={80} name="displayName" type="text" />
            </div>
            <div className={styles.field}>
              <label htmlFor="register-email">Email</label>
              <input autoComplete="email" id="register-email" maxLength={254} name="email" required type="email" />
            </div>
            <div className={styles.field}>
              <label htmlFor="register-password">Password</label>
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
              <p className={styles.fieldHint} id="register-password-hint">Use 12–256 characters and avoid common passwords.</p>
            </div>
            <div className={styles.field}>
              <label htmlFor="register-confirm-password">Confirm password</label>
              <input autoComplete="new-password" id="register-confirm-password" maxLength={256} minLength={12} name="confirmPassword" required type="password" />
            </div>
            <button className={`${styles.button} ${styles.buttonPrimary}`} disabled={register.isPending || capabilities.isPending} type="submit">
              {register.isPending ? 'Creating account…' : capabilities.isPending ? 'Checking availability…' : 'Create account'}
            </button>
          </>
        )}
        <p className={styles.authFooter}>Already have an account? <Link className={styles.inlineLink} to="/login">Log in</Link></p>
      </form>
    </AuthPageFrame>
  );
};
