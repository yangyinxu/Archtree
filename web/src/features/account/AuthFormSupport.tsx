import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent, type ReactNode, type Ref } from 'react';

import { isEmailDomainUndeliverable, type AcceptedEmailRequest } from '../../api/account';
import type { EmailActionInput } from '../../api/accountSchemas';
import { useLocalization } from '../../localization/LocalizationProvider';
import styles from './AccountSurfaces.module.css';
import { suggestEmailCorrection } from './emailDomainSuggestion';

interface AuthPageFrameProps {
  eyebrow: string;
  title: string;
  description?: string;
  /** Lets multi-state pages move focus to the heading when the page's state replaces its content. */
  titleRef?: Ref<HTMLHeadingElement>;
  children: ReactNode;
}

/** Keeps public account forms visually and semantically consistent. */
export const AuthPageFrame = ({ eyebrow, title, description, titleRef, children }: AuthPageFrameProps) => (
  <div className={styles.page}>
    <div className={styles.authLayout}>
      <div>
        <p className={styles.eyebrow}>{eyebrow}</p>
        <h1 className={styles.pageTitle} ref={titleRef} tabIndex={titleRef ? -1 : undefined}>{title}</h1>
        {description && <p className={styles.lede}>{description}</p>}
      </div>
      {children}
    </div>
  </div>
);

/**
 * Moves focus to a page heading when an asynchronous state change replaces the
 * focused content (for example a link check finishing or a form giving way to
 * an invalid-link notice). The first state is left alone so the route's own
 * focus handling applies.
 */
export const useFocusOnStateChange = (stateKey: string, enabled = true) => {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const previous = useRef(stateKey);

  useEffect(() => {
    if (previous.current === stateKey) return;
    previous.current = stateKey;
    if (enabled) titleRef.current?.focus();
  }, [enabled, stateKey]);

  return titleRef;
};

interface AuthFormFeedbackProps {
  error?: string;
  status?: string;
  focusKey?: number;
}

/** Announces async form outcomes and moves focus to actionable errors. */
export const AuthFormFeedback = ({ error, status, focusKey }: AuthFormFeedbackProps) => {
  const errorRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error, focusKey]);

  return (
    <>
      {error && (
        <p className={styles.error} ref={errorRef} role="alert" tabIndex={-1}>
          {error}
        </p>
      )}
      {status && (
        <p className={styles.success} role="status" aria-live="polite" aria-atomic="true">
          {status}
        </p>
      )}
    </>
  );
};

/** How long typing must pause before a new typo suggestion appears. */
export const emailSuggestionDelayMilliseconds = 500;

/**
 * Suggests a correction for a mistyped popular email domain once typing
 * pauses, so it neither flickers nor interrupts a screen reader mid-word. A
 * suggestion that no longer fits the current value disappears at once.
 */
const useEmailSuggestion = (value: string) => {
  const [settledValue, setSettledValue] = useState(value);

  useEffect(() => {
    if (settledValue === value) return undefined;
    const timer = window.setTimeout(() => setSettledValue(value), emailSuggestionDelayMilliseconds);
    return () => window.clearTimeout(timer);
  }, [settledValue, value]);

  const current = suggestEmailCorrection(value);
  return current !== null && current === suggestEmailCorrection(settledValue) ? current : null;
};

interface EmailRequestFormOptions {
  /** Sends the request and resolves with the address it used. */
  request: (input: EmailActionInput) => Promise<AcceptedEmailRequest>;
  initialEmail?: string;
}

/**
 * Shared behavior of the public forms that email a link or code to a typed
 * address: sign-up, verification link and password recovery.
 *
 * - `422 email_domain_undeliverable` is an error on the email field, shown
 *   while the field still holds the rejected address, and focus returns to
 *   the field. It depends only on the domain, so it reveals no account state.
 *   Every other failure keeps the generic, account-safe message.
 * - An accepted request shows the exact address it used, with an action that
 *   clears the form for a different address.
 * - Submitting again (a resend) posts the field's current address, so a resend
 *   to an undeliverable domain is rejected again and nothing is sent, and a
 *   resend after a correction shows the corrected address.
 * - A likely typo of a popular provider's domain is suggested while typing
 *   and replaces the address only when selected.
 */
export const useEmailRequestForm = ({ request, initialEmail = '' }: EmailRequestFormOptions) => {
  const [email, setEmail] = useState(initialEmail);
  const inputRef = useRef<HTMLInputElement>(null);
  const mutation = useMutation({ mutationFn: request });
  const suggestion = useEmailSuggestion(email);
  const undeliverable = isEmailDomainUndeliverable(mutation.error);

  useEffect(() => {
    // Each rejection, a repeated one included, returns the listener to the field to fix the address.
    if (isEmailDomainUndeliverable(mutation.error)) inputRef.current?.focus();
  }, [mutation.error]);

  return {
    email,
    inputRef,
    suggestion,
    isPending: mutation.isPending,
    /** True while the field holds the address the server rejected as undeliverable. */
    domainRejected: undeliverable && mutation.variables?.email === email,
    /** Any other failure; pages reduce it to the generic request error. */
    failure: mutation.isError && !undeliverable ? mutation.error : null,
    failureKey: mutation.submittedAt,
    /** The address an accepted request was sent to; empty until a request is accepted. */
    sentTo: mutation.isSuccess ? mutation.data.email : '',
    changeEmail: setEmail,
    applySuggestion: () => {
      if (!suggestion) return;
      setEmail(suggestion);
      inputRef.current?.focus();
    },
    submit: (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      mutation.reset();
      mutation.mutate({ email });
    },
    /** Clears the address, outcome and error, and focuses the empty field. */
    chooseDifferentEmail: () => {
      mutation.reset();
      setEmail('');
      inputRef.current?.focus();
    }
  };
};

export type EmailRequestForm = ReturnType<typeof useEmailRequestForm>;

interface AuthEmailFieldProps {
  form: EmailRequestForm;
  id: string;
}

/** The email field of an email-request form, with its undeliverable-domain error and typo suggestion. */
export const AuthEmailField = ({ form, id }: AuthEmailFieldProps) => {
  const { t } = useLocalization();
  const errorId = `${id}-error`;

  return (
    <div className={`${styles.field} ${styles.emailField}`}>
      <label htmlFor={id}>{t('account.field.email')}</label>
      <input
        aria-describedby={form.domainRejected ? errorId : undefined}
        aria-invalid={form.domainRejected || undefined}
        autoComplete="email"
        id={id}
        maxLength={254}
        name="email"
        onChange={(event) => form.changeEmail(event.currentTarget.value)}
        ref={form.inputRef}
        required
        type="email"
        value={form.email}
      />
      {form.domainRejected && (
        <p className={styles.fieldError} id={errorId} role="alert">{t('auth.email.domain_undeliverable')}</p>
      )}
      {/* Mounted while empty, so each new suggestion is announced politely. */}
      <div aria-atomic="true" aria-live="polite">
        {form.suggestion && (
          <button className={styles.suggestionButton} onClick={form.applySuggestion} type="button">
            {t('auth.email.suggestion', { email: form.suggestion })}
          </button>
        )}
      </div>
    </div>
  );
};

interface EmailRequestSentProps {
  form: EmailRequestForm;
  /** The page's non-enumerating "check your email" status. */
  message: string;
}

/** Confirms an accepted request with the exact address it used and a way to start over with another one. */
export const EmailRequestSent = ({ form, message }: EmailRequestSentProps) => {
  const { t } = useLocalization();
  if (!form.sentTo) return null;

  return (
    <div className={`${styles.success} ${styles.sentPanel}`}>
      <p aria-atomic="true" aria-live="polite" role="status">
        {message}{' '}
        <span className={styles.sentTo}>{t('auth.email.sent_to', { email: form.sentTo })}</span>
      </p>
      <button className={styles.textButton} onClick={form.chooseDifferentEmail} type="button">
        {t('auth.email.use_different')}
      </button>
    </div>
  );
};

/** Reduces unexpected server details to a stable account-safe failure message. */
export const privateAccountActionError = (_error: unknown, localizedFallback: string) => localizedFallback;

/** Verification errors are safe to surface because they do not confirm account existence. */
export const verificationActionError = (_error: unknown, localizedFallback: string) => localizedFallback;

export const emailFromRouteState = (state: unknown) => {
  if (!state || typeof state !== 'object' || !('email' in state)) return '';
  const value = (state as { email?: unknown }).email;
  return typeof value === 'string' ? value.trim().slice(0, 254) : '';
};

export const noticeFromRouteState = (state: unknown) => {
  if (!state || typeof state !== 'object' || !('notice' in state)) return '';
  const value = (state as { notice?: unknown }).notice;
  return typeof value === 'string' ? value.trim().slice(0, 240) : '';
};
