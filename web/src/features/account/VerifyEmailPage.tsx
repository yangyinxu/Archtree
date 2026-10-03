import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';

import {
  confirmBrowserEmailVerification,
  inspectBrowserEmailVerification,
  requestBrowserEmailVerification
} from '../../api/account';
import { ApiError } from '../../api/client';
import { browserSessionQueryKey } from '../../api/session';
import { useLocalization } from '../../localization/LocalizationProvider';
import styles from './AccountSurfaces.module.css';
import {
  AuthFormFeedback,
  AuthPageFrame,
  emailFromRouteState,
  privateAccountActionError,
  useFocusOnStateChange
} from './AuthFormSupport';
import { useLinkToken } from './linkToken';

type VerificationView = 'checking' | 'error' | 'confirm' | 'invalid' | 'request';

const isLinkInvalid = (error: unknown) => error instanceof ApiError
  && error.kind === 'http'
  && error.status === 400;

interface VerificationRequestFormProps {
  initialEmail: string;
}

/** Requests a new verification link; the status never reveals whether the address needed one. */
const VerificationRequestForm = ({ initialEmail }: VerificationRequestFormProps) => {
  const { t } = useLocalization();
  const request = useMutation({ mutationFn: requestBrowserEmailVerification });
  const error = request.isError
    ? privateAccountActionError(request.error, t('account.common.request_error'))
    : '';

  return (
    <form
      aria-busy={request.isPending}
      className={styles.formCard}
      onSubmit={(event) => {
        event.preventDefault();
        request.reset();
        const form = new FormData(event.currentTarget);
        request.mutate({ email: String(form.get('email') ?? '') });
      }}
    >
      <h2 className={styles.formTitle}>{t('auth.verify.form_title')}</h2>
      <AuthFormFeedback
        error={error}
        status={request.isSuccess ? t('auth.email_link.sent') : ''}
        focusKey={request.submittedAt}
      />
      <div className={styles.field}>
        <label htmlFor="verify-email">{t('account.field.email')}</label>
        <input autoComplete="email" defaultValue={initialEmail} id="verify-email" maxLength={254} name="email" required type="email" />
      </div>
      <button className={`${styles.button} ${styles.buttonPrimary}`} disabled={request.isPending} type="submit">
        {request.isPending ? t('auth.email_link.sending') : t('auth.email_link.send')}
      </button>
      <p className={styles.authFooter}><Link className={styles.inlineLink} to="/login">{t('account.common.back_login')}</Link></p>
    </form>
  );
};

/**
 * Verifies the email of an account created before verification existed.
 *
 * With a link token, the page checks the link without consuming it and waits
 * for an explicit Verify email click, so link scanners that open the page
 * cannot verify the address. The password and other sessions stay unchanged;
 * the listener then logs in again. Without a token, or after an unusable link,
 * the page offers a non-enumerating request for a new link.
 */
export const VerifyEmailPage = () => {
  const { t } = useLocalization();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const token = useLinkToken();
  const [routeEmail] = useState(() => emailFromRouteState(location.state));
  const [linkInvalid, setLinkInvalid] = useState(false);
  // Mutation caches drop their variables (the token) when the page unmounts.
  const inspect = useMutation({ mutationFn: inspectBrowserEmailVerification, gcTime: 0 });
  const confirm = useMutation({
    mutationFn: confirmBrowserEmailVerification,
    gcTime: 0,
    onSuccess: () => {
      // The current session may belong to the account that is now verified.
      void queryClient.invalidateQueries({ queryKey: browserSessionQueryKey });
      navigate('/login', {
        replace: true,
        state: { email: inspect.data?.email, notice: t('auth.verify.success') }
      });
    },
    onError: (error) => {
      if (isLinkInvalid(error)) setLinkInvalid(true);
    }
  });
  const { mutate: inspectLink } = inspect;

  useEffect(() => {
    // Inspection is non-consuming, so StrictMode's repeated development effect
    // may safely ask twice; the mutation observer follows the latest request.
    if (!token) return;
    setLinkInvalid(false);
    inspectLink({ token });
  }, [inspectLink, token]);

  const view: VerificationView = !token
    ? 'request'
    : linkInvalid || isLinkInvalid(inspect.error)
      ? 'invalid'
      : inspect.isSuccess
        ? 'confirm'
        : inspect.isError ? 'error' : 'checking';
  const titleRef = useFocusOnStateChange(view, view !== 'error');
  const eyebrow = t('auth.verify.eyebrow');

  if (view === 'request' || view === 'invalid') {
    return (
      <AuthPageFrame
        eyebrow={eyebrow}
        title={view === 'invalid' ? t('auth.link.invalid_title') : t('auth.email_link.request_title')}
        description={view === 'invalid' ? t('auth.email_link.invalid_copy') : t('auth.email_link.request_description')}
        titleRef={titleRef}
      >
        <VerificationRequestForm initialEmail={inspect.data?.email ?? routeEmail} />
      </AuthPageFrame>
    );
  }

  if (view === 'checking' || view === 'error') {
    return (
      <AuthPageFrame eyebrow={eyebrow} title={t('auth.email_link.title')} titleRef={titleRef}>
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

  const email = inspect.data?.email ?? '';
  const error = confirm.isError && !linkInvalid
    ? privateAccountActionError(confirm.error, t('account.common.request_error'))
    : '';

  return (
    <AuthPageFrame
      eyebrow={eyebrow}
      title={t('auth.email_link.title')}
      description={t('auth.email_link.description')}
      titleRef={titleRef}
    >
      <form
        aria-busy={confirm.isPending}
        className={styles.formCard}
        onSubmit={(event) => {
          event.preventDefault();
          confirm.reset();
          if (token) confirm.mutate({ token });
        }}
      >
        <h2 className={styles.formTitle}>{t('auth.verify.form_title')}</h2>
        <AuthFormFeedback error={error} focusKey={confirm.submittedAt} />
        <div className={styles.field}>
          <label htmlFor="verify-link-email">{t('account.field.email')}</label>
          <input autoComplete="username" id="verify-link-email" name="email" readOnly type="email" value={email} />
        </div>
        <button className={`${styles.button} ${styles.buttonPrimary}`} disabled={confirm.isPending} type="submit">
          {confirm.isPending ? t('auth.verify.verifying') : t('auth.verify.action')}
        </button>
        <p className={styles.authFooter}><Link className={styles.inlineLink} to="/login">{t('account.common.back_login')}</Link></p>
      </form>
    </AuthPageFrame>
  );
};
