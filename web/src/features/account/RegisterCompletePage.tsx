import { useMutation } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';

import {
  completeBrowserRegistration,
  inspectBrowserRegistration
} from '../../api/account';
import { registrationDisplayNameSchema } from '../../api/accountSchemas';
import { ApiError } from '../../api/client';
import { useLocalization } from '../../localization/LocalizationProvider';
import styles from './AccountSurfaces.module.css';
import {
  AuthFormFeedback,
  AuthPageFrame,
  useFocusOnStateChange
} from './AuthFormSupport';
import { useLinkToken } from './linkToken';

type LinkView = 'checking' | 'invalid' | 'exists' | 'error' | 'form';

const isHttpError = (error: unknown, status: number) => error instanceof ApiError
  && error.kind === 'http'
  && error.status === status;

/** Maps an inspection outcome to the page state; only 400 and 409 have a dedicated state. */
const inspectView = (status: 'idle' | 'pending' | 'success' | 'error', error: unknown): LinkView => {
  if (status === 'success') return 'form';
  if (status !== 'error') return 'checking';
  if (isHttpError(error, 400)) return 'invalid';
  if (isHttpError(error, 409)) return 'exists';
  return 'error';
};

/**
 * Finishes Web registration from an emailed link. The token is read from the
 * fragment, checked with a non-consuming request, and spent only when the
 * listener submits a display name and password. The account is created
 * verified and no session is installed: the listener is sent to Log in with
 * the address prefilled, so a session for another account stays untouched.
 */
export const RegisterCompletePage = () => {
  const { t } = useLocalization();
  const navigate = useNavigate();
  const token = useLinkToken();
  const [terminalView, setTerminalView] = useState<'invalid' | 'exists' | null>(null);
  const [localError, setLocalError] = useState('');
  const [attempt, setAttempt] = useState(0);
  // Mutation caches drop their variables (the token, the password) when the page unmounts.
  const inspect = useMutation({ mutationFn: inspectBrowserRegistration, gcTime: 0 });
  const complete = useMutation({
    mutationFn: completeBrowserRegistration,
    gcTime: 0,
    onSuccess: ({ email }) => {
      navigate('/login', {
        replace: true,
        state: { email, notice: t('auth.register_complete.success') }
      });
    },
    onError: (error) => {
      if (isHttpError(error, 400)) setTerminalView('invalid');
      else if (isHttpError(error, 409)) setTerminalView('exists');
    }
  });
  const { mutate: inspectLink } = inspect;

  useEffect(() => {
    // Inspection is non-consuming, so StrictMode's repeated development effect
    // may safely ask twice; the mutation observer follows the latest request.
    if (!token) return;
    setTerminalView(null);
    inspectLink({ token });
  }, [inspectLink, token]);

  const view: LinkView = !token ? 'invalid' : terminalView ?? inspectView(inspect.status, inspect.error);
  const titleRef = useFocusOnStateChange(view, view !== 'error');
  const email = inspect.data?.email ?? '';
  const eyebrow = t('auth.register_complete.eyebrow');

  if (view === 'invalid') {
    return (
      <AuthPageFrame
        eyebrow={eyebrow}
        title={t('auth.link.invalid_title')}
        description={t('auth.register_complete.invalid_copy')}
        titleRef={titleRef}
      >
        <div className={styles.formCard}>
          <Link className={`${styles.button} ${styles.buttonPrimary}`} to="/register">{t('auth.register_complete.request_new')}</Link>
          <p className={styles.authFooter}>{t('auth.register.already_account')} <Link className={styles.inlineLink} to="/login">{t('common.action.log_in')}</Link></p>
        </div>
      </AuthPageFrame>
    );
  }

  if (view === 'exists') {
    return (
      <AuthPageFrame
        eyebrow={eyebrow}
        title={t('auth.register_complete.exists_title')}
        description={t('auth.register_complete.exists_copy')}
        titleRef={titleRef}
      >
        <div className={styles.formCard}>
          <Link
            className={`${styles.button} ${styles.buttonPrimary}`}
            state={email ? { email } : undefined}
            to="/login"
          >
            {t('common.action.log_in')}
          </Link>
          <Link className={`${styles.button} ${styles.buttonSecondary}`} to="/forgot-password">{t('auth.login.forgot_password')}</Link>
        </div>
      </AuthPageFrame>
    );
  }

  if (view === 'checking' || view === 'error') {
    return (
      <AuthPageFrame eyebrow={eyebrow} title={t('auth.register_complete.title')} titleRef={titleRef}>
        <div aria-busy={view === 'checking'} className={styles.formCard}>
          {view === 'checking' ? (
            <p className={styles.panelCopy} role="status">{t('auth.link.checking')}</p>
          ) : (
            <>
              <AuthFormFeedback error={t('account.common.request_error')} focusKey={inspect.submittedAt} />
              <button
                className={`${styles.button} ${styles.buttonPrimary}`}
                onClick={() => {
                  if (token) inspectLink({ token });
                }}
                type="button"
              >
                {t('common.action.try_again')}
              </button>
            </>
          )}
        </div>
      </AuthPageFrame>
    );
  }

  const completeError = complete.error;
  const error = localError || (complete.isError && !terminalView
    ? completeError instanceof ApiError && completeError.status === 422 && completeError.code === 'invalid_password'
      ? t('auth.register_complete.password_rejected')
      : completeError instanceof ApiError && completeError.status === 422 && completeError.code === 'invalid_display_name'
        ? t('auth.register_complete.name_rejected')
        : t('account.common.request_error')
    : '');

  return (
    <AuthPageFrame
      eyebrow={eyebrow}
      title={t('auth.register_complete.title')}
      description={t('auth.register_complete.description')}
      titleRef={titleRef}
    >
      <form
        aria-busy={complete.isPending}
        className={styles.formCard}
        onSubmit={(event) => {
          event.preventDefault();
          setAttempt((value) => value + 1);
          setLocalError('');
          complete.reset();
          const form = new FormData(event.currentTarget);
          const displayName = registrationDisplayNameSchema.safeParse(String(form.get('displayName') ?? ''));
          if (!displayName.success) {
            setLocalError(t('auth.register_complete.name_rejected'));
            return;
          }
          const password = String(form.get('password') ?? '');
          if (password !== String(form.get('confirmPassword') ?? '')) {
            setLocalError(t('account.common.password_mismatch'));
            return;
          }
          if (!token) return;
          complete.mutate({ token, password, displayName: displayName.data });
        }}
      >
        <h2 className={styles.formTitle}>{t('auth.register_complete.form_title')}</h2>
        <AuthFormFeedback error={error} focusKey={attempt} />
        <div className={styles.field}>
          <label htmlFor="register-complete-email">{t('account.field.email')}</label>
          {/* Read-only, but a real field so password managers save the new password for this address. */}
          <input autoComplete="username" id="register-complete-email" name="email" readOnly type="email" value={email} />
        </div>
        <div className={styles.field}>
          <label htmlFor="register-complete-name">{t('account.field.display_name')}</label>
          <input autoComplete="name" id="register-complete-name" maxLength={80} name="displayName" required type="text" />
        </div>
        <div className={styles.field}>
          <label htmlFor="register-complete-password">{t('account.field.password')}</label>
          <input
            aria-describedby="register-complete-password-hint"
            autoComplete="new-password"
            id="register-complete-password"
            maxLength={256}
            minLength={12}
            name="password"
            required
            type="password"
          />
          <p className={styles.fieldHint} id="register-complete-password-hint">{t('account.common.password_hint')}</p>
        </div>
        <div className={styles.field}>
          <label htmlFor="register-complete-confirm-password">{t('account.field.confirm_password')}</label>
          <input autoComplete="new-password" id="register-complete-confirm-password" maxLength={256} minLength={12} name="confirmPassword" required type="password" />
        </div>
        <button className={`${styles.button} ${styles.buttonPrimary}`} disabled={complete.isPending} type="submit">
          {complete.isPending ? t('auth.register.creating') : t('auth.register_complete.action')}
        </button>
        <p className={styles.authFooter}>{t('auth.register.already_account')} <Link className={styles.inlineLink} to="/login">{t('common.action.log_in')}</Link></p>
      </form>
    </AuthPageFrame>
  );
};
